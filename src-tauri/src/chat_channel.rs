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
/// OSC 7501 程序状态（program_status.rs）：开始支持的版本（Orca 实测表，2026-10-17）；本机 2026-10-22 实测
/// Claude Code 2.1.306、Grok 1.0.67 都会报。只在这家没有别的旁路时用它
const PROGRAM_STATUS_MIN: &[(&str, (u32, u32, u32))] =
    &[("claude-code", (2, 1, 295)), ("grok", (1, 0, 60))];
/// CLI 自己报的一句现状（程序状态 msg）上限
const STATUS_LINE_CAP: usize = 240;
/// 这一轮实时文字最多留多少字符（只给预览用，正文以会话文件为准）
const LIVE_TEXT_CAP: usize = 24_000;
/// 一段思考摘要最多留多少字节（聊天层只取开头一句当状态）
const THINKING_CAP: usize = 2_000;
/// 正在跑的工具的参数里，单个字符串最多留多少字符（认得出命令 / 文件就够，差异正文不要）
const ACTIVITY_STR_CAP: usize = 1_200;
/// 审批卡里命令 / 差异 / 参数的长度上限
const PREVIEW_CAP: usize = 6_000;
/// 方案卡里方案原文的长度上限（Claude 计划模式的方案常有几屏，卡上整篇照 Markdown 排）
const PLAN_CAP: usize = 40_000;
/// 往前端推快照的最短间隔（实时文字一字一个事件，合并着推）
const EMIT_INTERVAL: Duration = Duration::from_millis(150);
/// 回合收尾后多久内到的文字 / 思考增量算晚到的尾巴（毫秒）
const STRAGGLER_MS: i64 = 1000;
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
    pub error: Option<String>,
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
    /// Claude 计划模式出完方案、问要不要开工（ExitPlanMode）时的方案原文（Markdown）
    pub plan: Option<String>,
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
    /// hooks | qwen | opencode | codex | program-status
    pub kind: &'static str,
    /// 网络旁路的连接状态；文件 / hooks 旁路为 None。断开后本次运行回退到会话文件与读屏。
    pub connection: Option<&'static str>,
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
    /// 正在跑的工具（最近开始、还没结束的那个）：聊天层「现在在做什么」用，比会话文件早到
    pub activity: Option<ActivityDto>,
    /// 这一段思考的摘要（Codex 推理摘要、Qwen / OpenCode 的思考增量）；工具开始或正文开始写就清掉
    pub thinking: Option<String>,
    /// CLI 自己报的一句现状（程序状态旁路的 msg，如 Grok「Connection failed | Retrying (1/15)」）；回合开始 / 结束清掉
    pub status_line: Option<String>,
    pub retry: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    /// CLI 自己的工具名（前端 tool-activity.ts 按名字归类成「运行 / 读取 / 编辑 …」）
    pub name: String,
    /// 参数 JSON：长字符串截断、逐个脱敏，只够认出在做什么（见 slim_value）
    pub input: String,
    /// 毫秒时间戳
    pub started_at: i64,
}

// ===== 事件 =====

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChannelEvent {
    Connected,
    Disconnected,
    Retrying(String),
    ErrorDetail(String),
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
    /// 思考摘要的增量（Codex 推理摘要 / Qwen、OpenCode 思考）
    ThinkingDelta(String),
    /// 新的一段思考开始：前一段的摘要作废
    ThinkingBreak,
    /// CLI 自己报的一句现状（None = 清掉）
    StatusLine(Option<String>),
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
    /// 排在当前这张后面的审批（带请求 id 的旁路才有：同一回复里并行的几个工具各要一次批准，
    /// CLI 逐个问；后到的不能顶掉还没答的那张）。(内容, 所属工具 id)
    queued: Vec<(ApprovalDto, Option<String>)>,
    /// 正在跑的工具（按开始先后；并行时有几个）：snap.activity 取最后一个
    running: Vec<(Option<String>, ActivityDto)>,
    /// 这一轮已经结束的工具 id：后台 hook 的结束可能比开始先到，晚到的开始不再算在跑
    finished: std::collections::HashSet<String>,
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
                connection: matches!(kind, "codex" | "opencode").then_some("connecting"),
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
            error: None,
            started_at: now,
            ended_at: None,
        });
        self.snap.live_text = None;
        self.snap.approval = None;
        self.approval_call = None;
        self.queued.clear();
        self.pending_break = false;
        self.ended.clear();
        self.running.clear();
        self.finished.clear();
        self.snap.activity = None;
        self.snap.thinking = None;
        self.snap.status_line = None;
        self.snap.retry = None;
    }

    /// 带请求 id 的审批（Codex / Qwen / OpenCode）：撤卡只认「已处理」事件、它自己那个工具结束、这一轮结束
    fn approval_has_id(&self) -> bool {
        self.snap.approval.as_ref().is_some_and(|a| a.request_id.is_some())
    }

    /// 当前这张答完：换上排着的下一张，没有就回到「在跑」
    fn next_approval(&mut self) {
        if self.queued.is_empty() {
            self.snap.approval = None;
            self.approval_call = None;
            self.set_status("running");
        } else {
            let (dto, call) = self.queued.remove(0);
            self.snap.approval = Some(dto);
            self.approval_call = call;
        }
    }

    fn ensure_running(&mut self, now: i64) {
        if !is_open(&self.snap.turn) {
            self.start_turn(now);
        }
    }

    /// 回合刚收尾（1 秒内）才到的文字 / 思考增量是晚到的尾巴：不能拿它重开一轮——重开的这一轮没有人再收尾，转圈不灭。
    /// 真正的新一轮都有自己的开始事件（TurnStart / 提问）
    fn straggler(&self, now: i64) -> bool {
        self.snap
            .turn
            .as_ref()
            .and_then(|t| t.ended_at)
            .is_some_and(|ended| (0..STRAGGLER_MS).contains(&(now - ended)))
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
        let tracked = ev.clone();
        if self.async_hooks
            && matches!(
                ev,
                ChannelEvent::ToolStart { .. } | ChannelEvent::ApprovalAsked { .. } | ChannelEvent::ToolEnd { .. }
            )
        {
            self.apply_async_tool(ev, now);
        } else {
            self.apply_event(ev, now);
        }
        self.track_activity(&tracked, now);
        self.snap != before
    }

    /// 「现在在做什么」：正在跑的工具与这一段思考摘要（回合状态与审批之外的另一条线，放在事件处理之后算——
    /// 回合开始会清空它们，开始事件要先开回合再登记）
    fn track_activity(&mut self, ev: &ChannelEvent, now: i64) {
        match ev {
            ChannelEvent::ToolStart { call_id, name, input } => {
                if call_id.as_ref().is_some_and(|id| self.finished.contains(id)) {
                    return;
                }
                let input = slim_input(input);
                // 同一个调用再报一次（OpenCode 先 pending 后 running、参数补全）：原地更新
                let same = call_id
                    .as_ref()
                    .and_then(|id| self.running.iter_mut().find(|(c, _)| c.as_deref() == Some(id.as_str())));
                if let Some((_, a)) = same {
                    a.input = input;
                } else {
                    self.running.push((
                        call_id.clone(),
                        ActivityDto { name: name.clone(), input, started_at: now },
                    ));
                }
                // 想完了、动手了：这一段思考的摘要不再是「现在」
                self.snap.thinking = None;
            }
            ChannelEvent::ToolEnd { call_id } => match call_id {
                Some(id) => {
                    self.finished.insert(id.clone());
                    self.running.retain(|(c, _)| c.as_deref() != Some(id.as_str()));
                }
                None => {
                    self.running.pop();
                }
            },
            ChannelEvent::TextDelta(text) if !text.is_empty() => {
                // 开始写回复：工具都跑完了，思考也结束了
                self.running.clear();
                self.snap.thinking = None;
            }
            ChannelEvent::ThinkingBreak => self.snap.thinking = None,
            ChannelEvent::ThinkingDelta(text) if !text.is_empty() => {
                let cur = self.snap.thinking.get_or_insert_with(String::new);
                if cur.len() < THINKING_CAP {
                    cur.push_str(text);
                    if cur.len() > THINKING_CAP {
                        let end = (0..=THINKING_CAP).rev().find(|i| cur.is_char_boundary(*i)).unwrap_or(0);
                        cur.truncate(end);
                    }
                }
            }
            ChannelEvent::TurnEnd { .. } => {
                self.running.clear();
                self.snap.thinking = None;
            }
            _ => {}
        }
        self.snap.activity = self.running.last().map(|(_, a)| a.clone());
    }

    fn apply_event(&mut self, ev: ChannelEvent, now: i64) {
        match ev {
            ChannelEvent::Retrying(message) => {
                self.ensure_running(now);
                self.snap.retry = Some(redact_cap(&message));
            }
            ChannelEvent::ErrorDetail(message) => {
                if let Some(t) = self.snap.turn.as_mut() { t.error = Some(redact_cap(&message)); }
            }
            ChannelEvent::Connected => self.snap.connection = Some("connected"),
            ChannelEvent::Disconnected => {
                self.snap.connection = Some("disconnected");
                self.snap.turn = None;
                self.snap.approval = None;
                self.snap.live_text = None;
                self.snap.activity = None;
                self.snap.thinking = None;
                self.snap.status_line = None;
                self.snap.retry = None;
                self.running.clear();
                self.queued.clear();
                self.tools.clear();
                self.last_tool = None;
                self.approval_call = None;
            }
            ChannelEvent::Session { id, path, source } => {
                // Codex 在 Windows 上恢复会话时给的是 `\\?\C:\…` 形态，统一成普通路径（其余平台原样）
                let path = path.map(|p| {
                    crate::paths::strip_verbatim(PathBuf::from(p))
                        .to_string_lossy()
                        .into_owned()
                });
                let changed_id = self.snap.session_id.as_deref() != Some(id.as_str());
                let changed_path = path.is_some() && self.snap.transcript_path != path;
                if changed_id && self.snap.session_id.is_some() {
                    self.snap.turn = None;
                    self.snap.approval = None;
                    self.snap.live_text = None;
                    self.snap.thinking = None;
                    self.snap.activity = None;
                    self.snap.status_line = None;
                    self.snap.retry = None;
                    self.snap.transcript_path = None;
                    self.snap.session_source = None;
                    self.tools.clear();
                    self.last_tool = None;
                    self.running.clear();
                    self.queued.clear();
                    self.finished.clear();
                    self.ended.clear();
                    self.approval_call = None;
                    self.approval_src = None;
                    self.pending_break = false;
                }
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
                self.snap.retry = None;
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
                self.snap.retry = None;
                // 等批准时来了下一个工具：上一个已经答过了。只对推断出来的审批（hooks）这样认——带请求 id 的
                // 审批另有「已处理」事件；同一回复里并行的工具（Codex 跑命令的同时调 MCP）开始了不等于答过，
                // 原先这里撤了卡，终端菜单还挂着，聊天层改由读屏再出一张英文原文的卡（2026-10-21 用户：先中文后英文两张）
                if self.snap.approval.is_some()
                    && !self.approval_has_id()
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
                if dto.request_id.is_some() {
                    // 带请求 id 的：只认它自己报的工具，不拿「最近一个工具」猜（并行时猜错了会被别的工具结束撤掉）
                    let same = self.snap.approval.as_ref().is_some_and(|a| a.request_id == dto.request_id);
                    if self.approval_has_id() && !same {
                        // 前一张还没答：排在后面，答完再出
                        if !self.queued.iter().any(|(q, _)| q.request_id == dto.request_id) {
                            self.queued.push((dto, call_id));
                        }
                    } else {
                        self.approval_call = call_id;
                        self.snap.approval = Some(dto);
                    }
                } else {
                    self.approval_call = call_id.or_else(|| {
                        self.last_tool.as_ref().and_then(|(id, _, _)| id.clone())
                    });
                    self.snap.approval = Some(dto);
                }
                self.set_status("awaiting_approval");
            }
            ChannelEvent::ApprovalResolved { request_id } => {
                if let Some(id) = &request_id {
                    self.queued.retain(|(q, _)| q.request_id.as_deref() != Some(id.as_str()));
                }
                let matches = match (&self.snap.approval, &request_id) {
                    (Some(a), Some(id)) => a.request_id.as_deref() == Some(id.as_str()),
                    (Some(_), None) => true,
                    _ => false,
                };
                if matches {
                    self.next_approval();
                }
            }
            ChannelEvent::ToolEnd { call_id } => {
                if let Some(id) = &call_id {
                    self.queued.retain(|(_, c)| c.as_deref() != Some(id.as_str()));
                }
                let answered = if self.approval_has_id() {
                    // 只有它自己那个工具结束才算答过（「已处理」事件丢了的兜底）
                    call_id.is_some() && call_id == self.approval_call
                } else {
                    call_id.is_none() || self.approval_call.is_none() || call_id == self.approval_call
                };
                if self.snap.approval.is_some() && answered {
                    self.next_approval();
                }
            }
            ChannelEvent::TextDelta(text) => {
                if text.is_empty() || self.straggler(now) {
                    return;
                }
                self.ensure_running(now);
                self.snap.retry = None;
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
                let status = match reason.as_deref() {
                    Some("failed" | "error" | "error_during_execution") => "failed",
                    Some("interrupted" | "cancelled" | "aborted") => "cancelled",
                    _ => "completed",
                };
                if self.snap.turn.is_none() && status != "completed" { self.start_turn(now); }
                if let Some(t) = self.snap.turn.as_mut() {
                    // idle 可能先到，随后具体的失败 / 中断结果仍要兑现；普通 idle 不能盖掉异常。
                    if t.ended_at.is_none() || (t.status == "completed" && status != "completed") {
                        t.status = status;
                        t.stop_reason = reason;
                        t.ended_at = Some(now);
                    }
                }
                self.snap.approval = None;
                self.approval_call = None;
                self.queued.clear();
                self.snap.status_line = None;
                self.snap.retry = None;
            }
            ChannelEvent::StatusLine(line) => {
                self.snap.status_line = line.map(|l| cap(l.trim(), STATUS_LINE_CAP));
            }
            ChannelEvent::Notice(text) => {
                let seq = self.snap.notice.as_ref().map(|n| n.seq).unwrap_or(0) + 1;
                self.snap.notice = Some(NoticeDto { seq, text });
            }
            ChannelEvent::ThinkingDelta(text) => {
                if !text.is_empty() && !self.straggler(now) {
                    self.ensure_running(now);
                }
            }
            ChannelEvent::ThinkingBreak => {}
        }
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

/// 已保存的密钥（脱敏用）：出字时每 150ms 推一次快照，不必每次都读 keys.json，5 秒内复用
fn secrets_for_redact() -> Vec<String> {
    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, list)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(5) {
            return list.clone();
        }
    }
    let list = crate::profiles::stored_secrets();
    *cache = Some((Instant::now(), list.clone()));
    list
}

/// 正在跑的工具的参数：长字符串截到 ACTIVITY_STR_CAP 个字符并逐个脱敏，数组 / 对象限量限深。
/// 前端拿它认出「运行 npm test」「编辑 store.ts」，不需要差异正文
fn slim_value(v: &Value, depth: usize, secrets: &[String]) -> Value {
    match v {
        Value::String(s) => {
            let cut = match s.char_indices().nth(ACTIVITY_STR_CAP) {
                Some((at, _)) => format!("{}…", &s[..at]),
                None => s.clone(),
            };
            Value::String(crate::sessions::redact_sensitive_text_with(&cut, secrets))
        }
        Value::Array(a) if depth < 3 => {
            Value::Array(a.iter().take(20).map(|x| slim_value(x, depth + 1, secrets)).collect())
        }
        Value::Object(m) if depth < 3 => Value::Object(
            m.iter()
                .take(40)
                .map(|(k, x)| (k.clone(), slim_value(x, depth + 1, secrets)))
                .collect(),
        ),
        Value::Array(_) | Value::Object(_) => Value::Null,
        other => other.clone(),
    }
}

fn slim_input(input: &Value) -> String {
    match input {
        Value::Null => String::new(),
        other => slim_value(other, 0, &secrets_for_redact()).to_string(),
    }
}

/// 出站前的快照：会话文本（实时文字、思考摘要）在 Rust 层脱敏再给前端（AGENTS.md 硬约束；工具参数在登记时已脱敏）
fn outbound(snap: &ChannelSnapshot) -> ChannelSnapshot {
    let mut out = snap.clone();
    if out.live_text.is_some() || out.thinking.is_some() || out.status_line.is_some() {
        let secrets = secrets_for_redact();
        let redact = |t: String| crate::sessions::redact_sensitive_text_with(&t, &secrets);
        out.live_text = out.live_text.map(redact);
        out.thinking = out.thinking.map(redact);
        out.status_line = out.status_line.map(redact);
    }
    out
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
    if is(&["requestuserinput", "question", "elicitation"]) {
        let mut lines = Vec::new();
        if let Some(message) = input.get("message").and_then(Value::as_str) { lines.push(message.to_string()); }
        if let Some(questions) = input.get("questions").and_then(Value::as_array) {
            for q in questions.iter().take(20) {
                if let Some(text) = q.get("question").and_then(Value::as_str) { lines.push(text.to_string()); }
                if let Some(options) = q.get("options").and_then(Value::as_array) {
                    for o in options.iter().take(20) {
                        if let Some(label) = o.get("label").and_then(Value::as_str) { lines.push(format!("• {label}")); }
                    }
                }
            }
        }
        dto.detail = Some(redact_cap(&lines.join("\n")));
        return dto;
    }
    // Claude 计划模式出完方案：2.1.308 起参数里只有已弃用的 allowedPrompts，hook 收到的 tool_input 由 CLI 补上
    // plan（方案文件全文）与 planFilePath（2026-10-26 假网关实测）。方案给卡片整篇排，不当参数 JSON 摊开
    if lower == "exitplanmode" {
        dto.plan = str_field(input, &["plan"])
            .map(|t| crate::sessions::redact_sensitive_text(&cap(&t, PLAN_CAP)));
        dto.path = str_field(input, &["planFilePath"]).map(|p| crate::sessions::redact_sensitive_text(&p));
        return dto;
    }
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
/// 程序状态（OSC 7501）→ 旁路事件。turn_open = 这一轮还开着。
/// - working：开一轮（已开着就不动）；之前卡住的那一问算答过了；msg 当现状一句
/// - blocked（要批准 / 在提问 / 要登录）：只在一轮进行中当审批——启动时的信任目录、登录页由读屏认（卡片按屏上原文给按钮），
///   这里不为它们开一轮（否则启动就转圈，违背「启动不转圈」）。卡片内容只有 msg 一句，按钮仍从屏上菜单来
/// - done / idle：收这一轮；error：按失败收
pub(crate) fn map_program_status(r: &crate::program_status::Report, turn_open: bool) -> Vec<ChannelEvent> {
    use crate::program_status::State;
    match r.state {
        State::Working => {
            let mut out = Vec::new();
            if turn_open {
                out.push(ChannelEvent::ApprovalResolved { request_id: None });
            } else {
                out.push(ChannelEvent::TurnStart);
            }
            out.push(ChannelEvent::StatusLine(r.msg.clone()));
            out
        }
        State::Blocked if turn_open => vec![ChannelEvent::ApprovalAsked {
            request_id: None,
            call_id: None,
            name: None,
            input: Value::Null,
            replyable: false,
            detail: r.msg.clone(),
        }],
        State::Done | State::Idle if turn_open => vec![ChannelEvent::TurnEnd { reason: None }],
        State::Error if turn_open => vec![ChannelEvent::TurnEnd { reason: Some("error".into()) }],
        _ => Vec::new(),
    }
}

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
                Some("content_block_start") => {
                    let block = ev.get("content_block").and_then(|b| b.get("type")).and_then(|x| x.as_str());
                    if block == Some("thinking") {
                        out.push(ChannelEvent::ThinkingBreak);
                    }
                }
                Some("content_block_delta") => {
                    let delta = ev.get("delta");
                    match delta.and_then(|d| d.get("type")).and_then(|x| x.as_str()) {
                        Some("text_delta") => {
                            if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|x| x.as_str()) {
                                out.push(ChannelEvent::TextDelta(t.to_string()));
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(t) = delta.and_then(|d| d.get("thinking")).and_then(|x| x.as_str()) {
                                out.push(ChannelEvent::ThinkingDelta(t.to_string()));
                            }
                        }
                        _ => {}
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
            // 一次模型回复里没有工具调用 = 这一轮的最后一条（交互态不发 result，实测 0.25.2）。
            // 内容为空的回复（模型什么都没说）只在明确给了非 tool_use 的 stop_reason 时才算收尾，
            // 免得把没写完的空快照当成结束
            let stop = v.get("message").and_then(|m| m.get("stop_reason")).and_then(|x| x.as_str());
            if tools == 0 && (!content.is_empty() || stop.is_some_and(|s| s != "tool_use")) {
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
            // 缺请求 id 的回执认不出是哪张卡的：ApprovalResolved{None} 会撤掉当前任意一张，宁可不撤（真答过了有 ToolEnd 等兜底）
            if let Some(id) = v
                .get("response")
                .and_then(|r| r.get("request_id"))
                .and_then(|x| x.as_str())
            {
                out.push(ChannelEvent::ApprovalResolved { request_id: Some(id.to_string()) });
            }
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
                Some("retry") => {
                    let status = &p["status"];
                    let attempt = status.get("attempt").and_then(Value::as_u64).unwrap_or(1);
                    let message = status.get("message").and_then(Value::as_str).unwrap_or("连接暂时不可用");
                    out.push(ChannelEvent::Retrying(format!("正在重试（第 {attempt} 次）：{message}")));
                }
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
        "session.error" => {
            let error = &p["error"];
            let cancelled = error.get("name").and_then(Value::as_str) == Some("MessageAbortedError");
            out.push(ChannelEvent::TurnEnd { reason: Some(if cancelled { "cancelled" } else { "failed" }.into()) });
            if let Some(message) = error.pointer("/data/message").or_else(|| error.get("message")).and_then(Value::as_str) {
                out.push(ChannelEvent::ErrorDetail(message.to_string()));
            }
        }
        "question.asked" => out.push(ChannelEvent::ApprovalAsked {
            request_id: p.get("id").and_then(Value::as_str).map(String::from),
            call_id: None, name: Some("question".into()), input: p.clone(), replyable: false, detail: None,
        }),
        "question.replied" | "question.rejected" => {
            if let Some(id) = p.get("requestID").and_then(Value::as_str) {
                out.push(ChannelEvent::ApprovalResolved { request_id: Some(id.into()) });
            }
        }
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
                "reasoning" if first => out.push(ChannelEvent::ThinkingBreak),
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
            if field == "text" {
                if let Some(d) = p.get("delta").and_then(|x| x.as_str()) {
                    match kind {
                        "text" => out.push(ChannelEvent::TextDelta(d.to_string())),
                        "reasoning" => out.push(ChannelEvent::ThinkingDelta(d.to_string())),
                        _ => {}
                    }
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
    /// 推理条目里出过摘要的：它的原始推理增量不再拼进思考摘要（两路混在一起读不通）
    summarized: std::collections::HashSet<String>,
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
        st.calls.clear();
        st.pending.clear();
        st.summarized.clear();
        st.subscribed = false;
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
                "item/tool/requestUserInput" if params.get("isBlocking").and_then(Value::as_bool) != Some(false) => {
                    out.push(ChannelEvent::ApprovalAsked { request_id: Some(key), call_id: item,
                        name: Some("requestUserInput".into()), input: params.clone(), replyable: false, detail: None });
                }
                "mcpServer/elicitation/request" => {
                    out.push(ChannelEvent::ApprovalAsked { request_id: Some(key), call_id: item,
                        name: Some("elicitation".into()), input: params.clone(), replyable: false, detail: None });
                }
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
                let is_child = thread.get("parentThreadId").is_some_and(|x| !x.is_null())
                    || thread.get("source").and_then(|s| s.get("subAgent")).is_some();
                let ephemeral = thread.get("ephemeral").and_then(Value::as_bool) == Some(true);
                let source = thread.get("threadSource").and_then(Value::as_str);
                // 私有服务还会发起 thread_title 等后台线程；只跟用户在 TUI 打开的对话。
                // 老版本不报 threadSource 时仅允许初次绑定，不能凭一个新根线程猜用户换了对话。
                let foreground = source == Some("user") || (source.is_none() && st.thread.is_none());
                if let Some(id) = id.filter(|id| !is_child && !ephemeral && foreground && st.thread.as_ref() != Some(id)) {
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
            "error" => {
                let message = params.pointer("/error/message").and_then(Value::as_str).unwrap_or("这次请求失败");
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    out.push(ChannelEvent::Retrying(format!("正在重试：{message}")));
                } else {
                    out.push(ChannelEvent::TurnEnd { reason: Some("failed".into()) });
                    out.push(ChannelEvent::ErrorDetail(message.to_string()));
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
                if let Some(message) = params.pointer("/turn/error/message").and_then(Value::as_str) {
                    out.push(ChannelEvent::ErrorDetail(message.to_string()));
                }
            }
            "item/agentMessage/delta" => {
                if let Some(d) = params.get("delta").and_then(|x| x.as_str()) {
                    out.push(ChannelEvent::TextDelta(d.to_string()));
                }
            }
            // 推理摘要（`**小标题**` + 一段话；一个推理条目可分几段，每段开头先报 summaryPartAdded）。
            // 摘要没开（或模型不给）时只有原始推理增量（第三方模型经网关常见），拿它兜底
            "item/reasoning/summaryPartAdded" => out.push(ChannelEvent::ThinkingBreak),
            "item/reasoning/summaryTextDelta" => {
                if let Some(id) = params.get("itemId").and_then(|x| x.as_str()) {
                    st.summarized.insert(id.to_string());
                }
                if let Some(d) = params.get("delta").and_then(|x| x.as_str()) {
                    out.push(ChannelEvent::ThinkingDelta(d.to_string()));
                }
            }
            "item/reasoning/textDelta" => {
                let summarized = params
                    .get("itemId")
                    .and_then(|x| x.as_str())
                    .is_some_and(|id| st.summarized.contains(id));
                if let (false, Some(d)) = (summarized, params.get("delta").and_then(|x| x.as_str())) {
                    out.push(ChannelEvent::ThinkingDelta(d.to_string()));
                }
            }
            "item/started" | "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let id = item.get("id").and_then(|x| x.as_str()).map(String::from);
                let ty = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                let started = m == "item/started";
                match ty {
                    "agentMessage" if started => out.push(ChannelEvent::TextBreak),
                    "reasoning" if started => out.push(ChannelEvent::ThinkingBreak),
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
    /// 这个标签用程序状态（OSC 7501）当旁路：PTY 读线程要答探询、把报告交给 `program_status_report`
    pub(crate) fn program_status(&self) -> bool {
        self.kind == "program-status"
    }

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
    let (env, prepared) = prepare_structured(agent, tab_id, cwd, binary, args, server_env, env_remove);
    if prepared.is_some() {
        return (env, prepared);
    }
    // 没有别的旁路：CLI 支持程序状态（OSC 7501）就用它——不写任何配置，PTY 读线程答探询、读报告。
    // Windows 不用：ConPTY 两个方向都吞 OSC（terminal.md「OSC 底色握手被 ConPTY 双向封死」），Grok 的探询到不了 Mesa、
    // 报告也出不来（2026-10-25 本机 Grok 1.0.67 实测输出里只有 OSC 0 / 12），开了只会让聊天层等一条永远不来的旁路
    let tab = tab_id.map(sanitize_tab).filter(|t| !t.is_empty());
    let supported = !cfg!(windows)
        && PROGRAM_STATUS_MIN
            .iter()
            .any(|(a, min)| *a == agent && version_at_least(agent, *min));
    match tab {
        Some(tab) if supported => (
            env,
            Some(Prepared {
                agent: agent.to_string(),
                tab_id: tab,
                kind: "program-status",
                dir: None,
                hooks_log: None,
                qwen_events: None,
                replier: None,
                codex: None,
            }),
        ),
        _ => (env, None),
    }
}

fn prepare_structured(
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
                let snap = ch.tracker.lock().ok().map(|t| outbound(&t.snap));
                if let Some(snap) = snap {
                    sink(Some(snap));
                }
            }
            std::thread::sleep(EMIT_INTERVAL);
        }
        // 重启接回时旧旁路晚一拍退出：同一标签已有新旁路在发快照，这个 None 会把新的盖掉（快照只在变化时才再发）
        if !superseded(&ch) {
            sink(None);
        }
    });
}

/// 同一标签已经登记了另一条旁路（这条是被它顶替掉的旧的）
fn superseded(ch: &Arc<Channel>) -> bool {
    registry()
        .lock()
        .map(|reg| reg.values().any(|c| c.tab_id == ch.tab_id && !Arc::ptr_eq(c, ch)))
        .unwrap_or(false)
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

/// 网络流有缺口后不能继续把旧快照当真值；保留会话身份给文件读取，撤掉官方回复入口。
fn disconnect(ch: &Channel) {
    if ch.stop.load(Ordering::Acquire) { return; }
    if let Ok(mut r) = ch.replier.lock() { *r = None; }
    feed(ch, vec![ChannelEvent::Disconnected]);
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
            if started.elapsed() >= Duration::from_secs(60) {
                disconnect(&ch);
                return;
            }
            // TUI 的服务还没起来：开头 60 秒内重试，之后回退
            let wait = if started.elapsed() < Duration::from_secs(60) {
                300
            } else {
                3000
            };
            tokio_sleep(wait).await;
            continue;
        };
        if !resp.status().is_success() {
            if started.elapsed() >= Duration::from_secs(60) { disconnect(&ch); return; }
            tokio_sleep(1000).await;
            continue;
        }
        feed(&ch, vec![ChannelEvent::Connected]);
        // 按字节攒、整行再解码：一个汉字可能被切在两块网络数据之间，逐块解码会变成「�」
        let mut buf: Vec<u8> = Vec::new();
        while !ch.stop.load(Ordering::Acquire) {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buf.extend_from_slice(&bytes);
                    while let Some(end) = buf.iter().position(|&b| b == b'\n') {
                        let raw: Vec<u8> = buf.drain(..=end).collect();
                        let line = String::from_utf8_lossy(&raw);
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
        // SSE 没有可重放的游标，重连会漏掉断线期间的审批与收尾，不能继续沿用旧状态。
        disconnect(&ch);
        return;
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
    let Some(stream) = stream else { disconnect(&ch); return };
    let Ok(writer) = stream.try_clone() else { disconnect(&ch); return };
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
        disconnect(&ch);
        return;
    }
    let _ = ws_send(&writer, &json!({ "jsonrpc": "2.0", "method": "initialized" }));
    feed(&ch, vec![ChannelEvent::Connected]);
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
    disconnect(&ch);
}

/// PTY 读线程读到程序状态报告（只有 program-status 旁路的标签会交来）
pub(crate) fn program_status_report(pty_id: &str, report: &crate::program_status::Report) {
    let Some(ch) = registry().lock().ok().and_then(|r| r.get(pty_id).cloned()) else {
        // 旁路还没登记（进程刚起、启动时的那一报）：启动时的状态不开回合，丢了无妨
        return;
    };
    let events = match ch.tracker.lock() {
        Ok(t) if t.snap.kind == "program-status" => map_program_status(report, is_open(&t.snap.turn)),
        _ => return,
    };
    feed(&ch, events);
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
    let snap = outbound(&ch.tracker.lock().ok()?.snap);
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

/// 人按了 Esc 打断 Claude、屏上「esc to interrupt」也没了（前端看屏确认后调）：收掉还开着的这一轮（interrupted）。
/// 还没出字就打断时 Claude 把这句退回输入框，会话文件里只留这句提问——没有打断标记、没有 turn_duration，也不发 Stop，
/// [`chat_channel_settle_from_transcript`] 等不到东西，聊天层停下后过一会又被旁路的「在回复」点亮成「思考中」
/// （2026-10-26 用户 Windows 实测 + 抓屏，Claude Code 2.1.310）。只认 hooks 家的 Claude、回合还开着；收了返回 true
#[tauri::command]
pub fn chat_channel_settle_interrupted(tab_id: String) -> bool {
    let Some(ch) = channel_for_tab(&tab_id) else {
        return false;
    };
    {
        let Ok(t) = ch.tracker.lock() else {
            return false;
        };
        let open = t.snap.turn.as_ref().is_some_and(|turn| turn.ended_at.is_none());
        if !(open && t.snap.kind == "hooks" && t.snap.agent == "claude-code") {
            return false;
        }
    }
    feed(&ch, vec![ChannelEvent::TurnEnd { reason: Some("interrupted".into()) }]);
    true
}

/// OpenCode 的单次 Esc 只进入取消提示；通过官方接口停止已核对的这一轮。
#[tauri::command]
pub async fn chat_channel_interrupt(tab_id: String, session_id: String, turn_seq: u32) -> Result<(), String> {
    interrupt_impl(&tab_id, &session_id, turn_seq).await
}

async fn interrupt_impl(tab_id: &str, session_id: &str, turn_seq: u32) -> Result<(), String> {
    let ch = channel_for_tab(tab_id).ok_or("实时通道不可用，请到终端停止")?;
    {
        let t = ch.tracker.lock().map_err(|_| "实时通道不可用")?;
        if t.snap.kind != "opencode" || t.snap.connection != Some("connected") {
            return Err("这条实时通道不支持停止，请到终端处理".into());
        }
        if t.snap.session_id.as_deref() != Some(session_id)
            || t.snap.turn.as_ref().map(|t| t.seq) != Some(turn_seq) || !is_open(&t.snap.turn) {
            return Err("当前回合已经变化，请按最新状态操作".into());
        }
    }
    let (port, password) = {
        let r = ch.replier.lock().map_err(|_| "实时通道不可用")?;
        match r.as_ref() {
            Some(Replier::OpenCode { port, password }) => (*port, password.clone()),
            _ => return Err("实时通道已断开，请到终端停止".into()),
        }
    };
    let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "无法构造停止请求")?.extend(["session", session_id, "abort"]);
    let response = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?.post(url)
        .header("Authorization", basic_auth(&password)).json(&json!({})).send().await
        .map_err(|e| format!("停止请求失败：{e}"))?;
    if !response.status().is_success() { return Err(format!("停止请求失败（{}）", response.status())); }
    // 官方确认后才收回合；响应到达前已切会话 / 开新一轮时，不触碰新状态。
    if let Ok(mut t) = ch.tracker.lock() {
        if t.snap.session_id.as_deref() == Some(session_id)
            && t.snap.turn.as_ref().map(|t| t.seq) == Some(turn_seq)
            && t.snap.connection == Some("connected") {
            if t.apply(ChannelEvent::TurnEnd { reason: Some("cancelled".into()) }, now_ms()) {
                ch.dirty.store(true, Ordering::Release);
            }
        }
    }
    Ok(())
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

    fn ps(state: crate::program_status::State, kind: Option<crate::program_status::BlockedKind>, msg: Option<&str>) -> crate::program_status::Report {
        crate::program_status::Report { state, kind, msg: msg.map(str::to_string) }
    }

    /// 把一串程序状态报告喂给 program-status 旁路（与 program_status_report 同一套：先按「这一轮开着没有」映射再应用）
    fn feed_ps(t: &mut Tracker, reports: &[crate::program_status::Report]) {
        for (i, r) in reports.iter().enumerate() {
            for ev in map_program_status(r, is_open(&t.snap.turn)) {
                t.apply(ev, i as i64);
            }
        }
    }

    #[test]
    fn final_failure_overrides_early_idle_and_preserves_redacted_error() {
        let mut st = CodexState::default();
        st.thread = Some("s".into());
        let mut t = tracker();
        t.apply(ChannelEvent::TurnStart, 1);
        for msg in [
            json!({"method":"thread/status/changed","params":{"threadId":"s","status":{"type":"idle"}}}),
            json!({"method":"turn/completed","params":{"threadId":"s","turn":{"status":"failed","error":{"message":"Bearer sk-live-secret-987654"}}}}),
            json!({"method":"thread/status/changed","params":{"threadId":"s","status":{"type":"idle"}}}),
        ] { for ev in map_codex(&msg, &mut st).0 { t.apply(ev, 2); } }
        let turn = t.snap.turn.as_ref().unwrap();
        assert_eq!(turn.status, "failed");
        assert!(!turn.error.as_ref().unwrap().contains("sk-live-secret-987654"));
        t.apply(ChannelEvent::TurnStart, 3);
        assert!(t.snap.turn.as_ref().unwrap().error.is_none());
    }

    #[test]
    fn retry_and_question_events_keep_truthful_waiting_state() {
        let mut st = OpenCodeState::default();
        let mut t = tracker();
        for ev in map_opencode(&json!({"type":"session.status","properties":{"sessionID":"s","status":{"type":"retry","attempt":2,"message":"rate limited"}}}), &mut st) { t.apply(ev, 1); }
        assert!(t.snap.retry.as_ref().unwrap().contains("第 2 次"));
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        for ev in map_opencode(&json!({"type":"question.asked","properties":{"sessionID":"s","id":"q","questions":[{"question":"选择哪种？","options":[{"label":"A"},{"label":"B"}]}]}}), &mut st) { t.apply(ev, 2); }
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        let a = t.snap.approval.as_ref().unwrap();
        assert!(!a.replyable);
        assert!(a.detail.as_ref().unwrap().contains("选择哪种？"));
        for ev in map_opencode(&json!({"type":"question.replied","properties":{"sessionID":"s","requestID":"other"}}), &mut st) { t.apply(ev, 3); }
        assert!(t.snap.approval.is_some());
        for ev in map_opencode(&json!({"type":"question.replied","properties":{"sessionID":"s","requestID":"q"}}), &mut st) { t.apply(ev, 4); }
        assert!(t.snap.approval.is_none());
        for ev in map_opencode(&json!({"type":"session.error","properties":{"sessionID":"s","error":{"name":"APIError","data":{"message":"quota exceeded"}}}}), &mut st) { t.apply(ev, 5); }
        assert_eq!(t.snap.turn.as_ref().unwrap().error.as_deref(), Some("quota exceeded"));
        assert!(t.snap.retry.is_none());
    }

    #[test]
    fn codex_blocking_input_and_mcp_forms_wait_without_fabricated_approval_choices() {
        for method in ["item/tool/requestUserInput", "mcpServer/elicitation/request"] {
            let mut st = CodexState::default();
            st.thread = Some("s".into());
            let mut t = tracker();
            let req = json!({"id":9,"method":method,"params":{"threadId":"s","itemId":"i","isBlocking":true,
                "message":"请补充信息", "questions":[{"question":"选择哪种？"}]}});
            for ev in map_codex(&req, &mut st).0 { t.apply(ev, 1); }
            assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
            assert!(!t.snap.approval.as_ref().unwrap().replyable);
            for ev in map_codex(&json!({"method":"serverRequest/resolved","params":{"threadId":"s","requestId":9}}), &mut st).0 { t.apply(ev, 2); }
            assert!(t.snap.approval.is_none());
        }
        let mut st = CodexState::default();
        st.thread = Some("s".into());
        assert!(map_codex(&json!({"id":10,"method":"item/tool/requestUserInput","params":{"threadId":"s","isBlocking":false}}), &mut st).0.is_empty());
        let events = map_codex(&json!({"method":"error","params":{"threadId":"s","willRetry":true,"error":{"message":"busy"}}}), &mut st).0;
        assert!(matches!(&events[0], ChannelEvent::Retrying(message) if message.contains("busy")));
    }

    #[test]
    fn codex_follows_user_thread_without_following_title_or_child_threads() {
        let mut st = CodexState::default();
        let started = |id: &str, source: &str, ephemeral: bool, parent: Value| json!({
            "method":"thread/started", "params":{"thread":{"id":id,"threadSource":source,
            "ephemeral":ephemeral,"parentThreadId":parent}}
        });
        let (_, first) = map_codex(&started("a", "user", false, Value::Null), &mut st);
        assert_eq!(st.thread.as_deref(), Some("a"));
        assert!(map_codex(&started("title", "thread_title", true, Value::Null), &mut st).0.is_empty());
        assert!(map_codex(&started("child", "user", false, json!("a")), &mut st).0.is_empty());
        st.pending.insert("old".into(), (json!(1), "item/fileChange/requestApproval".into()));
        let (events, _) = map_codex(&started("b", "user", false, Value::Null), &mut st);
        assert!(matches!(&events[0], ChannelEvent::Session { id, .. } if id == "b"));
        assert!(st.pending.is_empty());
        assert!(!st.subscribed);
        let (late, _) = map_codex(&json!({"id":first[0]["id"],"result":{"thread":{"id":"a","path":"/old"}}}), &mut st);
        assert!(late.is_empty(), "旧订阅响应不能把旧路径绑给新线程");
        assert!(map_codex(&started("b", "user", false, Value::Null), &mut st).1.is_empty(), "resume 重播不重复订阅");
    }

    #[test]
    fn switching_session_drops_previous_path_and_turn() {
        let mut t = tracker();
        t.apply(ChannelEvent::Session { id: "a".into(), path: Some("/a".into()), source: None }, 1);
        t.apply(ChannelEvent::TextDelta("old".into()), 2);
        t.apply(ChannelEvent::Session { id: "b".into(), path: None, source: None }, 3);
        assert_eq!(t.snap.session_id.as_deref(), Some("b"));
        assert!(t.snap.transcript_path.is_none());
        assert!(t.snap.turn.is_none());
        assert!(t.snap.live_text.is_none());
        assert_eq!(t.snap.session_seq, 1);
    }

    fn test_channel(tab: &str) -> Arc<Channel> {
        Arc::new(Channel {
            tab_id: tab.into(),
            stop: AtomicBool::new(false),
            tracker: Mutex::new(Tracker::new(tab, "codex", "codex")),
            dirty: AtomicBool::new(false),
            replier: Mutex::new(None),
            codex: Mutex::new(CodexState::default()),
            sidecar_pid: Mutex::new(None),
            dir: None,
        })
    }

    /// 重启接回：旧旁路晚一拍退出，不能在新旁路已登记时再向同一标签发 None 盖掉新快照
    #[test]
    fn replaced_channel_must_not_clear_the_new_snapshot() {
        let (old, new, other_tab) = (test_channel("sup-tab"), test_channel("sup-tab"), test_channel("sup-other"));
        let key = |s: &str| format!("sup-pty-{s}");
        assert!(!superseded(&old), "没有新旁路：正常关闭照发 None");
        registry().lock().unwrap().insert(key("new"), new.clone());
        registry().lock().unwrap().insert(key("other"), other_tab.clone());
        assert!(superseded(&old), "同一标签已有新旁路");
        assert!(!superseded(&new), "新旁路自己不算被顶替");
        assert!(!superseded(&other_tab), "别的标签不相干");
        registry().lock().unwrap().remove(&key("new"));
        registry().lock().unwrap().remove(&key("other"));
    }

    #[test]
    fn disconnect_withdraws_stale_authority_without_finishing_the_turn() {
        let mut t = Tracker::new("t", "codex", "codex");
        t.apply(ChannelEvent::Session { id: "s".into(), path: Some("/s".into()), source: None }, 1);
        t.apply(ChannelEvent::Connected, 2);
        t.apply(ChannelEvent::ToolStart { call_id: Some("c".into()), name: "shell".into(), input: json!({}) }, 3);
        t.apply(ChannelEvent::ApprovalAsked { request_id: Some("r".into()), call_id: Some("c".into()), name: Some("shell".into()), input: json!({}), replyable: true, detail: None }, 4);
        t.apply(ChannelEvent::Disconnected, 5);
        assert_eq!(t.snap.connection, Some("disconnected"));
        assert_eq!(t.snap.session_id.as_deref(), Some("s"));
        assert!(t.snap.turn.is_none());
        assert!(t.snap.approval.is_none());
        assert!(t.snap.activity.is_none());
        assert!(t.snap.live_text.is_none());
        assert!(t.queued.is_empty());
    }

    #[test]
    fn program_status_turn_lifecycle() {
        use crate::program_status::{BlockedKind::*, State::*};
        let mut t = Tracker::new("tab-1", "grok", "program-status");
        // 启动时的信任菜单 / 空闲：不开回合（启动不转圈，信任菜单交给读屏）
        feed_ps(&mut t, &[ps(Blocked, Some(Permission), Some("Trust this folder?")), ps(Idle, None, None)]);
        assert!(t.snap.turn.is_none());
        assert!(t.snap.approval.is_none());
        // 干活：开一轮，msg 是现状一句
        feed_ps(&mut t, &[ps(Working, None, Some("Waiting for response…"))]);
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        assert_eq!(t.snap.status_line.as_deref(), Some("Waiting for response…"));
        feed_ps(&mut t, &[ps(Working, None, Some("Connection failed | Retrying (1/15)"))]);
        assert_eq!(t.snap.turn.as_ref().unwrap().seq, 1, "同一轮里的进度不另开一轮");
        assert_eq!(t.snap.status_line.as_deref(), Some("Connection failed | Retrying (1/15)"));
        // 卡住要批准 → 等确认，卡上只有 msg；答完回到干活
        feed_ps(&mut t, &[ps(Blocked, Some(Permission), Some("approve Write: notes.md"))]);
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        let a = t.snap.approval.clone().unwrap();
        assert!(!a.replyable);
        assert_eq!(a.detail.as_deref(), Some("approve Write: notes.md"));
        feed_ps(&mut t, &[ps(Working, None, None)]);
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
        assert!(t.snap.approval.is_none());
        // 完成：收这一轮、清掉现状；之后的 idle 不再动
        feed_ps(&mut t, &[ps(Done, None, Some("Turn complete in 19s.")), ps(Idle, None, None)]);
        let turn = t.snap.turn.clone().unwrap();
        assert_eq!(turn.status, "completed");
        assert!(t.snap.status_line.is_none());
        // 下一轮出错
        feed_ps(&mut t, &[ps(Working, None, None), ps(Error, None, Some("boom"))]);
        let turn = t.snap.turn.clone().unwrap();
        assert_eq!((turn.seq, turn.status), (2, "failed"));
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

    /// 带请求 id 的审批（Codex / Qwen / OpenCode）：同一回复里并行的另一个工具开始、结束都不撤卡，
    /// 只认「已处理」或它自己那个工具结束；第二张审批排在第一张后面（2026-10-21 用户 Codex 实录：
    /// 跑命令要提权的同时调了 MCP，MCP 一结束卡就没了，读屏又出一张英文的）
    #[test]
    fn id_approvals_survive_parallel_tools_and_queue() {
        let mut t = Tracker::new("tab-1", "codex", "codex");
        let tool = |id: &str, cmd: &str| ChannelEvent::ToolStart {
            call_id: Some(id.into()),
            name: "commandExecution".into(),
            input: json!({ "command": cmd }),
        };
        let ask = |req: &str, call: &str, cmd: &str| ChannelEvent::ApprovalAsked {
            request_id: Some(req.into()),
            call_id: Some(call.into()),
            name: Some("commandExecution".into()),
            input: json!({ "command": cmd }),
            replyable: true,
            detail: None,
        };
        t.apply(ChannelEvent::TurnStart, 0);
        t.apply(tool("c1", "curl a"), 1);
        t.apply(ask("r1", "c1", "curl a"), 2);
        // 并行的 MCP 调用开始又结束：卡还在
        t.apply(ChannelEvent::ToolStart { call_id: Some("m1".into()), name: "js".into(), input: json!({}) }, 3);
        t.apply(ChannelEvent::ToolEnd { call_id: Some("m1".into()) }, 4);
        assert_eq!(t.snap.approval.as_ref().unwrap().request_id.as_deref(), Some("r1"));
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        // 第二个要批准的排在后面，不顶掉第一张
        t.apply(tool("c2", "curl b"), 5);
        t.apply(ask("r2", "c2", "curl b"), 6);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("curl a"));
        // 第一张答完，换上第二张
        t.apply(ChannelEvent::ApprovalResolved { request_id: Some("r1".into()) }, 7);
        assert_eq!(t.snap.approval.as_ref().unwrap().command.as_deref(), Some("curl b"));
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "awaiting_approval");
        // 「已处理」丢了：它自己那个工具结束也算答过
        t.apply(ChannelEvent::ToolEnd { call_id: Some("c2".into()) }, 8);
        assert!(t.snap.approval.is_none());
        assert_eq!(t.snap.turn.as_ref().unwrap().status, "running");
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
    fn late_deltas_after_turn_end_do_not_reopen_a_turn() {
        let mut t = Tracker::new("tab-q", "qwen", "qwen");
        t.apply(ChannelEvent::TurnStart, 1_000);
        t.apply(ChannelEvent::TurnEnd { reason: Some("end_turn".into()) }, 2_000);
        let ended = t.snap.turn.as_ref().unwrap().ended_at;
        // 1 秒内晚到的尾巴：不开新回合
        t.apply(ChannelEvent::ThinkingDelta("想".into()), 2_300);
        t.apply(ChannelEvent::TextDelta("尾".into()), 2_400);
        assert_eq!(t.snap.turn.as_ref().unwrap().ended_at, ended);
        assert!(t.snap.live_text.is_none());
        // 之后（或有自己的开始事件）照常开新一轮
        t.apply(ChannelEvent::TextDelta("新".into()), 4_000);
        assert!(t.snap.turn.as_ref().unwrap().ended_at.is_none());
    }

    #[test]
    fn qwen_empty_reply_ends_the_turn_only_with_an_explicit_stop() {
        let mut t = Tracker::new("tab-q", "qwen", "qwen");
        for (i, e) in [
            json!({"type":"user","message":{"role":"user","content":"hi"}}),
            // 没有 stop_reason 的空快照：不当结束
            json!({"type":"assistant","message":{"content":[]}}),
        ]
        .iter()
        .enumerate()
        {
            for ev in map_qwen(e) {
                t.apply(ev, i as i64);
            }
        }
        assert!(t.snap.turn.as_ref().unwrap().ended_at.is_none());
        for ev in map_qwen(&json!({"type":"assistant","message":{"stop_reason":"end_turn","content":[]}})) {
            t.apply(ev, 5);
        }
        assert!(t.snap.turn.as_ref().unwrap().ended_at.is_some());
    }

    #[test]
    fn qwen_control_response_without_request_id_keeps_the_card() {
        let ask = json!({"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"run_shell_command","tool_use_id":"c1","input":{"command":"ls"}}});
        let mut t = Tracker::new("tab-q", "qwen", "qwen");
        for ev in map_qwen(&ask) {
            t.apply(ev, 1);
        }
        assert!(t.snap.approval.is_some());
        // 缺号 / 别的请求的回执不撤这张卡
        for e in [
            json!({"type":"control_response","response":{"subtype":"success","response":{}}}),
            json!({"type":"control_response","response":{"subtype":"success","request_id":"other"}}),
        ] {
            for ev in map_qwen(&e) {
                t.apply(ev, 2);
            }
        }
        assert_eq!(t.snap.approval.as_ref().and_then(|a| a.request_id.as_deref()), Some("r1"));
        for ev in map_qwen(&json!({"type":"control_response","response":{"subtype":"success","request_id":"r1"}})) {
            t.apply(ev, 3);
        }
        assert!(t.snap.approval.is_none());
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
        let a = approval_from_tool(
            "ExitPlanMode",
            &json!({"plan":"# 方案\n\n1. 写探针","planFilePath":"/h/.claude/plans/a.md"}),
        );
        assert_eq!((a.kind, a.plan.as_deref(), a.path.as_deref(), a.detail.as_deref()), ("other", Some("# 方案\n\n1. 写探针"), Some("/h/.claude/plans/a.md"), None));
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

    #[test]
    fn activity_follows_running_tools() {
        let mut t = tracker();
        t.apply(ChannelEvent::TurnStart, 1);
        assert!(t.snap.activity.is_none());
        t.apply(tool("a", "Bash", json!({"command":"npm test","description":"跑测试"})), 2);
        let a = t.snap.activity.clone().unwrap();
        assert_eq!((a.name.as_str(), a.started_at), ("Bash", 2));
        assert_eq!(serde_json::from_str::<Value>(&a.input).unwrap()["command"], "npm test");
        // 并行：取最近开始的；它结束了回到前一个
        t.apply(tool("b", "Read", json!({"file_path":"/w/a.rs"})), 3);
        assert_eq!(t.snap.activity.as_ref().unwrap().name, "Read");
        t.apply(end("b"), 4);
        assert_eq!(t.snap.activity.as_ref().unwrap().name, "Bash");
        t.apply(end("a"), 5);
        assert!(t.snap.activity.is_none());
        // 开始写回复：没结束事件的工具也不再算在跑
        t.apply(tool("c", "Grep", json!({"pattern":"x"})), 6);
        t.apply(ChannelEvent::TextDelta("好了".into()), 7);
        assert!(t.snap.activity.is_none());
        t.apply(tool("d", "Bash", json!({"command":"ls"})), 8);
        t.apply(ChannelEvent::TurnEnd { reason: None }, 9);
        assert!(t.snap.activity.is_none(), "一轮结束清空");
    }

    #[test]
    fn activity_ignores_late_start_after_end_in_async_hooks() {
        // Windows 上 Claude 的 hooks 在后台跑，结束可能比开始先到
        let mut t = tracker();
        t.async_hooks = true;
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(end("x"), 2);
        t.apply(tool("x", "Bash", json!({"command":"echo hi"})), 3);
        assert!(t.snap.activity.is_none());
        t.apply(tool("y", "Edit", json!({"file_path":"/w/b.rs","old_string":"a","new_string":"b"})), 4);
        assert_eq!(t.snap.activity.as_ref().unwrap().name, "Edit");
    }

    #[test]
    fn activity_input_is_slimmed_and_redacted() {
        let long = "x".repeat(ACTIVITY_STR_CAP + 50);
        let input = slim_input(&json!({
            "command": format!("curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123' {long}"),
            "nested": {"deep": {"deeper": {"deepest": "gone"}}},
        }));
        let v: Value = serde_json::from_str(&input).unwrap();
        let cmd = v["command"].as_str().unwrap();
        assert!(!cmd.contains("sk-abcdefghijklmnopqrstuvwxyz0123"), "{cmd}");
        assert!(cmd.ends_with('…') && cmd.chars().count() <= ACTIVITY_STR_CAP + 1);
        assert!(v["nested"]["deep"]["deeper"].is_null(), "限深");
        assert_eq!(slim_input(&Value::Null), "");
    }

    #[test]
    fn thinking_from_codex_reasoning_summary() {
        let mut st = CodexState::default();
        let mut t = Tracker::new("tab-c", "codex", "codex");
        let apply = |msg: Value, st: &mut CodexState, t: &mut Tracker| {
            for ev in map_codex(&msg, st).0 {
                t.apply(ev, 1);
            }
        };
        apply(json!({"method":"thread/started","params":{"thread":{"id":"th1","path":"/r/x.jsonl","parentThreadId":null}}}), &mut st, &mut t);
        apply(json!({"method":"turn/started","params":{"threadId":"th1","turn":{"id":"u1"}}}), &mut st, &mut t);
        let reason = |m: &str, extra: Value| {
            let mut p = json!({"threadId":"th1","turnId":"u1","itemId":"r1","summaryIndex":0});
            if let (Some(o), Some(e)) = (p.as_object_mut(), extra.as_object()) {
                o.extend(e.clone());
            }
            json!({"method": m, "params": p})
        };
        apply(json!({"method":"item/started","params":{"threadId":"th1","turnId":"u1","item":{"type":"reasoning","id":"r1","summary":[],"content":[]}}}), &mut st, &mut t);
        apply(reason("item/reasoning/summaryPartAdded", json!({})), &mut st, &mut t);
        apply(reason("item/reasoning/summaryTextDelta", json!({"delta":"**规划修复步骤**\n\n先看"})), &mut st, &mut t);
        apply(reason("item/reasoning/summaryTextDelta", json!({"delta":"调用方"})), &mut st, &mut t);
        // 有摘要的条目，原始推理增量不再拼进来
        apply(reason("item/reasoning/textDelta", json!({"delta":"raw"})), &mut st, &mut t);
        assert_eq!(t.snap.thinking.as_deref(), Some("**规划修复步骤**\n\n先看调用方"));
        // 新的一段摘要：前一段作废
        apply(reason("item/reasoning/summaryPartAdded", json!({"summaryIndex":1})), &mut st, &mut t);
        assert!(t.snap.thinking.is_none());
        apply(reason("item/reasoning/summaryTextDelta", json!({"delta":"**跑测试**"})), &mut st, &mut t);
        // 动手了：思考不再是「现在」
        apply(json!({"method":"item/started","params":{"threadId":"th1","turnId":"u1","item":{"type":"commandExecution","id":"c1","command":"/bin/zsh -lc 'npm test'"}}}), &mut st, &mut t);
        assert!(t.snap.thinking.is_none());
        let a = t.snap.activity.clone().unwrap();
        assert_eq!(a.name, "commandExecution");
        assert!(a.input.contains("npm test"));
        // 没有摘要的模型：原始推理兜底
        apply(json!({"method":"item/started","params":{"threadId":"th1","turnId":"u1","item":{"type":"reasoning","id":"r2","summary":[],"content":[]}}}), &mut st, &mut t);
        apply(json!({"method":"item/reasoning/textDelta","params":{"threadId":"th1","turnId":"u1","itemId":"r2","delta":"想一想","contentIndex":0}}), &mut st, &mut t);
        assert_eq!(t.snap.thinking.as_deref(), Some("想一想"));
    }

    #[test]
    fn thinking_from_qwen_and_opencode() {
        let mut t = Tracker::new("tab-q", "qwen", "qwen");
        let ev = |delta: Value| json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":delta}});
        for e in [
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}),
            ev(json!({"type":"thinking_delta","thinking":"先看目录"})),
        ] {
            for x in map_qwen(&e) {
                t.apply(x, 1);
            }
        }
        assert_eq!(t.snap.thinking.as_deref(), Some("先看目录"));
        for x in map_qwen(&ev(json!({"type":"text_delta","text":"好的"}))) {
            t.apply(x, 2);
        }
        assert!(t.snap.thinking.is_none(), "开始写回复就清掉");

        let mut st = OpenCodeState::default();
        let mut t = Tracker::new("tab-o", "opencode", "opencode");
        let part = json!({"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"p1","type":"reasoning","sessionID":"ses_1"}}});
        let delta = json!({"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"m1","partID":"p1","field":"text","delta":"想想怎么改"}});
        for e in [part, delta] {
            for x in map_opencode(&e, &mut st) {
                t.apply(x, 1);
            }
        }
        assert_eq!(t.snap.thinking.as_deref(), Some("想想怎么改"));
        assert!(t.snap.live_text.is_none(), "思考不进实时正文");
    }

    #[test]
    fn thinking_is_capped() {
        let mut t = tracker();
        t.apply(ChannelEvent::TurnStart, 1);
        t.apply(ChannelEvent::ThinkingDelta("想".repeat(THINKING_CAP)), 2);
        t.apply(ChannelEvent::ThinkingDelta("更多".into()), 3);
        let th = t.snap.thinking.clone().unwrap();
        assert!(th.len() <= THINKING_CAP && !th.contains("更多"));
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
        /// 快照里出现过的「正在跑的工具」（名字 + 参数，去重按先后）与思考摘要
        activities: Vec<String>,
        thoughts: Vec<String>,
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
        let last_out = Arc::new(Mutex::new(Instant::now()));
        // E2E_RAW=<文件>：终端原始输出按时间逐块记下（{"t":毫秒,"d":原文}，审批答完之后另记一行 {"t","mark"}），
        // 用终端模拟器回放就能看到「聊天层答过以后终端里还挂着什么」
        let raw_log: Option<Arc<Mutex<std::fs::File>>> = std::env::var("E2E_RAW")
            .ok()
            .and_then(|p| std::fs::File::create(p).ok())
            .map(|f| Arc::new(Mutex::new(f)));
        let t0 = Instant::now();
        // 程序状态旁路（OSC 7501）：照 pty.rs 读线程答探询、把报告交给旁路
        let program_status = prepared.program_status();
        {
            let (screen, writer, raw_log, last_out) = (screen.clone(), writer.clone(), raw_log.clone(), last_out.clone());
            std::thread::spawn(move || {
                let mut queries = crate::term_query::QueryScanner::new(program_status);
                let mut reports = crate::program_status::ReportScanner::default();
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    *last_out.lock().unwrap() = Instant::now();
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if let Some(f) = &raw_log {
                        let line = json!({ "t": t0.elapsed().as_millis() as u64, "d": chunk }).to_string();
                        let _ = writeln!(f.lock().unwrap(), "{line}");
                    }
                    if program_status {
                        for r in reports.feed(&buf[..n]) {
                            println!("  [7501] {:?} {:?} {:?}", r.state, r.kind, r.msg);
                            program_status_report("e2e-pty", &r);
                        }
                    }
                    // 终端查询照 Mesa 的口径应答（src/terminal-protocols.ts 的子集；程序状态探询走 term_query）
                    let mut w = writer.lock().unwrap();
                    if program_status {
                        for reply in queries.feed(&buf[..n]) {
                            if reply.starts_with(b"\x1b]7501") {
                                let _ = w.write_all(&reply);
                            }
                        }
                    }
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
        // 等 CLI 画完再动手：至少 min，之后要有输出且安静 1.5 秒，最多 max。固定等 9 秒在 CI 的慢机器上会把字打进
        // 还没准备好的输入框（2026-10-25：Windows Codex、macOS Grok 同版本时过时不过）；一直在转圈的家到 max 照旧往下走
        let settle = |min: u64, max: u64| {
            let t = Instant::now();
            std::thread::sleep(Duration::from_secs(min));
            while t.elapsed() < Duration::from_secs(max) {
                let quiet = last_out.lock().unwrap().elapsed() >= Duration::from_millis(1500);
                if quiet && !screen.lock().unwrap().is_empty() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        };
        settle(9, 45);
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
            settle(2, 20);
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
            // 输入框画出来了也可能还没接字（2026-10-25/26 Windows Codex 经 --remote 起，屏上停在空输入框、字被吞）：
            // 打完看回显里有没有触发词，4 秒没出现就隔一会再打，最多三次
            let marker = prompt.split_whitespace().next().unwrap_or("").to_string();
            for attempt in 0..3 {
                screen.lock().unwrap().clear();
                send(prompt.as_bytes());
                let typed_at = Instant::now();
                let echoed = loop {
                    let shown = crate::updater::strip_ansi_keep_cr(&screen.lock().unwrap());
                    if marker.is_empty() || shown.contains(&marker) {
                        break true;
                    }
                    if typed_at.elapsed() >= Duration::from_secs(4) {
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                };
                if echoed {
                    break;
                }
                println!("{agent}: 第 {} 次打字没回显，等输入框就绪再打", attempt + 1);
                settle(2, 10);
            }
            // E2E_SUBMIT_GAP_MS：正文与回车的间隔，照聊天层发送（pty_input 的提交间隔）复现「字留在输入框」
            let gap = std::env::var("E2E_SUBMIT_GAP_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(400);
            std::thread::sleep(Duration::from_millis(gap));
            send(b"\r");
        }
        let started = Instant::now();
        let mut answered = None;
        let mut approval = None;
        let mut done = false;
        // E2E_INTERRUPT_MS：发出后过这么久按 Esc（同聊天层的停止按钮），再过 1.5 秒照前端口径收回合（chat_channel_settle_interrupted）。
        // 配 E2E_PROMPT="TRIGGER_THINK TRIGGER_SLOW 讲一段" 与假网关 E2E_THINK_FILE + E2E_THINK_DELAY：还没出字就打断，Claude 不发 Stop
        let interrupt_ms: Option<u64> = std::env::var("E2E_INTERRUPT_MS").ok().and_then(|v| v.parse().ok());
        let mut esc_at: Option<Instant> = None;
        let mut interrupt_settled = false;
        while started.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(300));
            if let (Some(ms), None) = (interrupt_ms, esc_at) {
                if started.elapsed() >= Duration::from_millis(ms) {
                    if agent == "opencode" {
                        let snap = chat_channel_snapshot("e2e-tab".into()).unwrap_or_default();
                        if let (Some(sid), Some(turn)) = (&snap.session_id, &snap.turn) {
                            if is_open(&snap.turn) {
                                assert!(tauri::async_runtime::block_on(interrupt_impl("e2e-tab", sid, turn.seq + 1)).is_err(), "过期回合不能停止当前任务");
                                tauri::async_runtime::block_on(interrupt_impl("e2e-tab", sid, turn.seq)).expect("OpenCode 官方停止接口");
                                esc_at = Some(Instant::now());
                                interrupt_settled = true;
                                println!("{agent}: 官方接口已确认停止");
                            }
                        }
                    } else {
                        send(b"\x1b");
                        esc_at = Some(Instant::now());
                        println!("{agent}: 按了 Esc");
                    }
                }
            }
            if let Some(at) = esc_at.filter(|_| !interrupt_settled) {
                if at.elapsed() >= Duration::from_millis(1500) {
                    let before = snaps.lock().unwrap().last().cloned().unwrap_or_default();
                    let status = before.turn.as_ref().map(|t| t.status.clone()).unwrap_or_default();
                    let r = chat_channel_settle_interrupted("e2e-tab".into());
                    println!("{agent}: Esc 1.5 秒后回合状态 {status}，chat_channel_settle_interrupted → {r}");
                    interrupt_settled = true;
                }
            }
            let last = snaps.lock().unwrap().last().cloned();
            let Some(last) = last else { continue };
            if let (Some(a), None) = (&last.approval, &answered) {
                approval = Some(a.clone());
                if a.replyable {
                    // E2E_REPLY_DELAY_MS：像人一样看一会儿卡片再点（终端菜单此时已画出）
                    if let Some(ms) = std::env::var("E2E_REPLY_DELAY_MS").ok().and_then(|v| v.parse().ok()) {
                        std::thread::sleep(Duration::from_millis(ms));
                    }
                    let id = a.request_id.clone().unwrap();
                    let r = tauri::async_runtime::block_on(reply_impl("e2e-tab", &id, "allow"));
                    answered = Some(format!("聊天层回复（{r:?}）"));
                    if let Some(f) = &raw_log {
                        let line = json!({ "t": t0.elapsed().as_millis() as u64, "mark": "answered" }).to_string();
                        let _ = writeln!(f.lock().unwrap(), "{line}");
                    }
                } else if started.elapsed() > Duration::from_secs(3) {
                    // E2E_ANSWER=esc：不答，在终端按 Esc 取消（Claude 提问表单 / 审批菜单被拒时不发 Stop，看会话文件收尾能不能收掉回合）
                    if std::env::var("E2E_ANSWER").as_deref() == Ok("esc") {
                        send(b"\x1b");
                        answered = Some("终端菜单 Esc".into());
                    } else {
                        send(b"\r");
                        answered = Some("终端菜单回车".into());
                    }
                }
            }
            // 同前端读会话文件时顺带问的那一下（chat_channel_settle_from_transcript）
            if answered.as_deref() == Some("终端菜单 Esc") && chat_channel_settle_from_transcript("e2e-tab".into()) {
                println!("{agent}: 会话文件收尾收掉了回合");
            }
            let ran = last.turn.as_ref().is_some_and(|t| t.status == "completed" || t.status == "cancelled");
            // 新进程的状态机从第 0 轮起算：走完一轮就是发的这句（回放的旧轮不算回合）
            // 按 Esc 不答的那一轮不会跑命令，没有探针文件
            let esc = answered.as_deref() == Some("终端菜单 Esc") || interrupt_settled;
            if ran && (!need_probe || esc || probe.exists()) {
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
        let mut activities: Vec<String> = Vec::new();
        let mut thoughts: Vec<String> = Vec::new();
        for s in &all {
            if let Some(a) = &s.activity {
                let line = format!("{} {}", a.name, a.input);
                if !activities.contains(&line) {
                    activities.push(line);
                }
            }
            if let Some(t) = s.thinking.as_ref().filter(|t| !t.is_empty()) {
                if !thoughts.contains(t) {
                    thoughts.push(t.clone());
                }
            }
        }
        Run {
            done,
            last: all.last().cloned().unwrap_or_default(),
            statuses,
            approval,
            answered,
            cleared,
            arg_prompt_ok,
            activities,
            thoughts,
        }
    }

    fn report(agent: &str, label: &str, r: &Run) {
        println!("{agent}{label}: 会话 {:?} 文件 {:?}", r.last.session_id, r.last.transcript_path);
        println!("{agent}{label}: 回合状态变化 {:?}", r.statuses);
        println!("{agent}{label}: 审批 {:?}", r.approval.as_ref().map(|a| (a.kind, a.command.clone(), a.replyable)));
        if let Some(plan) = r.approval.as_ref().and_then(|a| a.plan.as_ref()) {
            println!("{agent}{label}: 审批带方案 {plan:?}");
        }
        println!("{agent}{label}: 答法 {:?}；实时文字 {:?}", r.answered, r.last.live_text);
        if r.cleared.is_some() {
            println!("{agent}{label}: /clear 之后 {:?}", r.cleared);
        }
        if r.arg_prompt_ok.is_some() {
            println!("{agent}{label}: 启动参数里的首条消息原样到达 {:?}", r.arg_prompt_ok);
        }
        println!("{agent}{label}: 正在跑的工具 {:?}", r.activities);
        println!("{agent}{label}: 思考摘要 {:?}", r.thoughts);
    }

    /// 旁路没报会话文件时，在临时 HOME 里找这段对话：OpenCode 是库路径 + `#` + 会话 id，其余按 `<会话 id>.jsonl`
    fn temp_home_transcript(agent: &str, home: &Path, session_id: Option<&str>) -> Option<String> {
        let sid = session_id?;
        let mut stack = vec![(home.to_path_buf(), 0)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if depth < 8 {
                        stack.push((p, depth + 1));
                    }
                    continue;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if agent == "opencode" && name == "opencode.db" {
                    return Some(format!("{}#{sid}", p.display()));
                }
                if agent != "opencode" && name == format!("{sid}.jsonl") {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
        None
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
        let real_home = crate::dirs::home_dir().unwrap();
        let home = std::env::temp_dir().join(format!("mesa-e2e-{}", uuid::Uuid::new_v4().simple()));
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        // E2E_CLEAN_HOME=1（CLI 金丝雀，scripts/cli-canary）：不拷本机配置——用户的 MCP / 插件 / hooks 会改工具清单，
        // 快照要在 CI 和各台机器上可比；只预置「已走完首次引导」，免得停在选主题
        let clean = std::env::var("E2E_CLEAN_HOME").is_ok();
        for rel in COPY.iter().filter(|_| !clean) {
            let src = real_home.join(rel);
            if src.is_file() {
                let dst = home.join(rel);
                std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
                std::fs::copy(&src, &dst).unwrap();
            }
        }
        let cj = home.join(".claude.json");
        if clean {
            std::fs::write(&cj, json!({ "hasCompletedOnboarding": true, "projects": {} }).to_string()).unwrap();
            // Windows 下面会设 CODEX_HOME，Codex 要求它已存在
            std::fs::create_dir_all(home.join(".codex")).unwrap();
        }
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
        // E2E_EXTRA_ENV="K=V;K=V"：金丝雀给个别家补的环境（如 Grok 出站指向不监听的代理，模拟连不上厂商云端）
        for pair in std::env::var("E2E_EXTRA_ENV").unwrap_or_default().split(';') {
            if let Some((k, v)) = pair.split_once('=') {
                env.push((k.to_string(), v.to_string()));
            }
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
        // E2E_KEEP=<目录>（CLI 金丝雀）：删临时 HOME 前留下会话文件原件、Mesa 解析器读出的对话、旁路走过的状态
        if let Ok(keep) = std::env::var("E2E_KEEP") {
            let keep = Path::new(&keep);
            std::fs::create_dir_all(keep).unwrap();
            // 程序状态旁路（Grok）不报会话文件：临时 HOME 里只有这一段对话，扫一遍取这家最新的那份
            let path = first.last.transcript_path.clone().or_else(|| {
                // Windows 上 crate::dirs::home_dir 不认 HOME / USERPROFILE，Mesa 的扫描看的是本机真实 HOME，
                // 会拿到用户自己最近的一段旧对话（2026-10-25 实测 Qwen / OpenCode）：直接在临时 HOME 里按会话 id 找
                if cfg!(windows) {
                    return temp_home_transcript(&agent, &home, first.last.session_id.as_deref());
                }
                crate::sessions::scan_sessions()
                    .sessions
                    .into_iter()
                    .filter(|m| m.agent == agent)
                    .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
                    .map(|m| m.file_path)
            });
            if let Some(p) = &path {
                let _ = std::fs::copy(p, keep.join("transcript.jsonl"));
            }
            let parsed = path.as_deref().map(|p| crate::sessions::conversation_impl_raw(&agent, p)).unwrap_or_default();
            std::fs::write(keep.join("parsed.json"), serde_json::to_string_pretty(&parsed).unwrap()).unwrap();
            let a = first.approval.as_ref();
            let channel = json!({
                "kind": first.last.kind,
                "sessionId": first.last.session_id.is_some(),
                "transcript": path.is_some(),
                "done": first.done,
                "statuses": first.statuses,
                "approvalKind": a.map(|a| a.kind),
                "approvalTool": a.and_then(|a| a.tool_name.clone()),
                "approvalReplyable": a.map(|a| a.replyable),
                "approvalCommand": a.and_then(|a| a.command.clone()),
                "answered": first.answered,
            });
            std::fs::write(keep.join("channel.json"), serde_json::to_string_pretty(&channel).unwrap()).unwrap();
        }
        let _ = std::fs::remove_dir_all(&home);
        // 程序状态旁路（OSC 7501）不带会话 id：会话仍按原来的认领找
        if first.last.kind != "program-status" {
            assert!(first.last.session_id.is_some(), "旁路认出会话");
        }
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
