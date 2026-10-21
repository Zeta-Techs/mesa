//! 聊天层 ⇄ 终端层交接纯逻辑（tests/chat-handoff.test.ts）。
//!
//! 聊天是同一 PTY 的结构化显示层，不复制九家 TUI 菜单解析器。
//! 能用已知字符串写进 PTY 的（直切 /model、/effort、y/n/Esc、生成中 Esc 暂停）留在聊天；
//! 方向键选择器、登录、信任目录交给终端画面——默认「窥视」（露出同一 xterm 底部，
//! 不改行列数），只有启动注入失败等必须粘贴进 TUI 输入框的才整层切走。

import type { ChatMessageDto, SessionSyncState } from "./types.ts";

/** 有精确状态（hooks 或结构化旁路，docs/design-chat-structured-channels.md）的八家；cursor 没有等价事件。
 *  键是 agent id（原先误写成 claude，Claude Code 一直被当成「没有精确注意力」，2026-10-20 改正） */
export const HOOKS_AGENTS: ReadonlySet<string> = new Set([
  "claude-code",
  "opencode",
  "qwen",
  "codebuddy",
  "gemini",
  "kimi",
  "grok",
  "codex",
]);

export type ChatHandoffEvent =
  | "send_message"
  | "direct_slash"
  | "picker_model"
  | "hooks_confirm"
  | "no_hooks_confirm"
  | "login_or_trust"
  | "prompt_dropped"
  | "self_update";

/** chat_ok = 聊天层独立完成；peek = 露出同一会话 TUI；must_switch = 整层切到终端 */
export type ChatHandoffAction = "chat_ok" | "peek" | "must_switch";

export type ChatWaitKind =
  | "idle"
  | "sent"
  | "writing"
  | "using_tool"
  | "no_session";

export function agentHasHooks(agentId: string | null | undefined): boolean {
  return Boolean(agentId && HOOKS_AGENTS.has(agentId));
}

export function confirmHandoffEvent(
  agentId: string | null | undefined,
  hooksEnabled: boolean,
): Extract<ChatHandoffEvent, "hooks_confirm" | "no_hooks_confirm"> {
  return agentHasHooks(agentId) && hooksEnabled
    ? "hooks_confirm"
    : "no_hooks_confirm";
}

export function handoffFor(event: ChatHandoffEvent): ChatHandoffAction {
  switch (event) {
    case "send_message":
    case "direct_slash":
      return "chat_ok";
    case "picker_model":
    case "hooks_confirm":
    case "no_hooks_confirm":
    case "login_or_trust":
      return "peek";
    case "prompt_dropped":
    case "self_update":
      return "must_switch";
  }
}

export function shouldAutoPeek(event: ChatHandoffEvent): boolean {
  const action = handoffFor(event);
  return action === "peek" || action === "must_switch";
}

/** 审批卡片附加说明：不解析 TUI，只提示已知失效原因 */
export function approvalExtraHint(
  agentId: string | null | undefined,
  hooksEnabled: boolean,
): string | null {
  // Codex 原先走全局 hooks（要在 /hooks 面板信任）；2026-10-20 起 Mesa 里改走私有 app-server，不再提示
  if (!agentHasHooks(agentId) || !hooksEnabled) {
    return "这家 Agent 没有精确注意力标记，批准菜单请在露出的终端里操作";
  }
  return null;
}

export function latestToolName(
  messages: Pick<ChatMessageDto, "role" | "blocks">[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return null;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j];
      if (block.kind === "tool_use" && block.toolName) return block.toolName;
    }
  }
  return null;
}

export function hasAssistantText(
  messages: Pick<ChatMessageDto, "role" | "blocks">[],
): boolean {
  return messages.some(
    (message) =>
      message.role !== "user" &&
      message.blocks.some(
        (block) => block.kind === "text" && Boolean(block.text?.trim()),
      ),
  );
}

export function chatWaitKind(input: {
  pendingReply: boolean;
  running: boolean;
  syncState: SessionSyncState;
  messageCount: number;
  stuckWaiting: boolean;
  toolName: string | null;
}): ChatWaitKind {
  if (input.stuckWaiting) return "no_session";
  if (!input.pendingReply) {
    if (
      input.running &&
      input.syncState === "waiting" &&
      input.messageCount === 0
    ) {
      return "idle";
    }
    return "idle";
  }
  if (input.toolName) return "using_tool";
  if (input.syncState === "watching" || input.syncState === "polling") {
    return "writing";
  }
  return "sent";
}

export function chatWaitText(
  kind: ChatWaitKind,
  toolName?: string | null,
): string {
  switch (kind) {
    case "sent":
      return "已送出";
    case "writing":
      // 会话文件一段写完聊天层才看得到；终端里是实时的（聊天层另给「看实时输出」）
      return "正在生成回复";
    case "using_tool":
      return toolName ? `正在用 ${toolName}` : "正在调用工具";
    case "no_session":
      return "会话文件还没出现（去终端看确认）";
    default:
      return "";
  }
}

/**
 * 聊天头状态微字。未发过、也没在跑时不要写「等待会话文件」——
 * 同步通道默认 waiting，那是还没开始，不是丢了文件。
 */
export function chatHeaderStatus(input: {
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  running: boolean;
  canResume: boolean;
  messageCount: number;
}): string {
  const { state, syncState, running, canResume, messageCount } = input;
  const started = running || messageCount > 0;
  if (state === "detecting" || syncState === "detecting") return "识别会话";
  if (!started) return state === "timeout" && canResume ? "可恢复" : "";
  if (state === "timeout" && canResume) return "可恢复";
  if (state === "timeout") return "等待会话文件";
  if (syncState === "waiting") return "等待会话文件";
  if (syncState === "polling") return running ? "同步中" : "已结束 · 可继续";
  if (syncState === "watching") return running ? "实时同步" : "已结束 · 可继续";
  if (state === "linked") return running ? "实时同步" : "已结束 · 可继续";
  return running ? "Agent 运行中" : "准备开始";
}

/** 发送钮变「进行中」暂停：只在正在出字，或刚发出还在等首个助手字
 * （pendingReply 窗口里输入框已清、上一轮正文已落——发送钮没有发送对象）。
 * 停在提示符时要点发送；审批 confirm 时 Esc 归审批卡，不占发送钮。 */
export function composerShowsInterrupt(input: {
  running?: boolean;
  attention?: "done" | "working" | "confirm" | null;
  pendingReply?: boolean;
}): boolean {
  if (!input.running) return false;
  if (input.attention === "confirm") return false;
  return input.attention === "working" || Boolean(input.pendingReply);
}

/**
 * 发出去的是斜杠 / ! 命令时，会话文件里记的不是原话：Claude 把 /cost 记成 /usage、拆成命令标签、
 * 新版还写成 system 行（解析成 command 块）。所以不比文字，只看「发送之后出现了命令块」。
 * 不这样认，本地命令永远「没落盘」，聊天层的「正在生成回复」就一直挂着（2026-10-19 用户发 /cost 实测，
 * 之后别的提问都跑完了还在转圈）。
 */
export function slashCommandRecorded(
  sent: Pick<ChatMessageDto, "blocks" | "timestamp">,
  parsed: readonly Pick<ChatMessageDto, "role" | "blocks" | "timestamp">[],
  skewMs = 5000,
): boolean {
  const text = (sent.blocks[0]?.text ?? "").trim();
  if (!/^[/!]/.test(text)) return false;
  const since = Date.parse(sent.timestamp ?? "");
  if (!Number.isFinite(since)) return false;
  return parsed.some((message) => {
    if (message.role !== "user" || !message.blocks.some((b) => b.kind === "command")) return false;
    const at = Date.parse(message.timestamp ?? "");
    return Number.isFinite(at) && at >= since - skewMs;
  });
}

/**
 * Claude 会话文件里的权限模式 → 聊天权限徽标的档（与 cli_permission.rs claude_note 同一张表）。
 * 只认三档能对上的；plan（只讨论由 Mesa 启动参数保证）、acceptEdits、dontAsk 对不上，返回 null 不动徽标。
 */
export function claudeModeTier(mode: string | null | undefined): "ask" | "auto" | "full" | null {
  switch (mode) {
    case "default":
    case "manual":
      return "ask";
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "full";
    default:
      return null;
  }
}

/** 会把斜杠命令记进会话文件的家（slashCommandRecorded 认得出）：不在本机提前收尾，免得同一条记两遍 */
const RECORDS_SLASH_COMMANDS = new Set(["claude-code"]);
/** 发出后至少这么久、终端至少静了这么久，才算本机已经处理完 */
export const SLASH_LOCAL_SETTLE_MS = 1500;
export const SLASH_LOCAL_QUIET_MS = 1000;

/**
 * 斜杠 / ! 命令在本机已经处理完、不必再等会话文件：Codex 的 /status 这类命令只画在终端里，会话文件里永远没有，
 * 原先「正在生成回复」一直挂着，之后几轮都收不了尾（2026-10-19 用户截图：联网那轮结束后还写「正在用 exec_command 5 分钟」）。
 * 终端里开着面板时不算（面板关掉命令才结束，Claude 那条路由 tui-panel 管）。
 */
export function slashSettledLocally(input: {
  agentId: string;
  sent: Pick<ChatMessageDto, "blocks" | "timestamp">;
  now: number;
  lastOutputAt: number;
  panelOpen: boolean;
}): boolean {
  if (RECORDS_SLASH_COMMANDS.has(input.agentId) || input.panelOpen) return false;
  const text = (input.sent.blocks[0]?.text ?? "").trim();
  if (!/^[/!]\S/.test(text)) return false;
  const since = Date.parse(input.sent.timestamp ?? "");
  if (!Number.isFinite(since)) return false;
  return (
    input.now - since >= SLASH_LOCAL_SETTLE_MS && input.now - input.lastOutputAt >= SLASH_LOCAL_QUIET_MS
  );
}

/**
 * 本机处理完的斜杠命令留成一条「命令 + 结果」（结果取那一刻终端里这条命令后面的几行，聊天层实时预览读出来的那段）。
 * 只在这次打开的聊天里有：会话文件里没有，重开后看不到，以终端为准
 */
export function localCommandRecord(
  sent: Pick<ChatMessageDto, "blocks" | "timestamp">,
  screen: readonly string[] | null,
): ChatMessageDto {
  const text = (sent.blocks[0]?.text ?? "").trim();
  let lines = [...(screen ?? [])];
  const echo = lines.map((l) => l.trim()).lastIndexOf(text);
  if (echo >= 0) lines = lines.slice(echo + 1);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const output = lines.slice(0, 80).join("\n");
  return {
    role: "user",
    blocks: [
      { kind: "command", text, toolName: null },
      ...(output ? [{ kind: "command_output" as const, text: output, toolName: null }] : []),
    ],
    timestamp: sent.timestamp,
    usage: null,
  };
}

/** 本机命令记录按时间插回解析结果（插在第一条比它晚的消息前；都比它早就接在最后） */
export function mergeLocalRecords(
  parsed: readonly ChatMessageDto[],
  locals: readonly ChatMessageDto[],
): ChatMessageDto[] {
  const out = [...parsed];
  for (const local of locals) {
    const at = Date.parse(local.timestamp ?? "");
    const idx = Number.isFinite(at)
      ? out.findIndex((m) => Date.parse(m.timestamp ?? "") > at)
      : -1;
    if (idx < 0) out.push(local);
    else out.splice(idx, 0, local);
  }
  return out;
}

/**
 * 发出去的话会话文件记下了没有。不逐字比：
 * - TUI 输入框有残留草稿（先发一半、审批框吞键等）时落盘是「残留 + 本文」（实证：yyyyyy你是什么模型）→ 包含即算；
 * - CLI 收不全字：Windows 上 Codex 把 emoji 吞掉、原位留个空格（2026-10-21 用户实测「"引号" 😀」落盘成「"引号" 」），
 *   原先这句一直算「没落盘」，同一句画两遍、「正在生成回复」挂到下一轮 → 两边去掉空白与 BMP 以外的字（emoji 及其拼接符）再比。
 * 去完什么都不剩（整句只有 emoji）只认原文，交给旁路回合结束兜底（pendingAfterTurn）。
 */
export function userTextRecorded(sent: string, recorded: string): boolean {
  if (recorded === sent || (sent.length > 0 && recorded.includes(sent))) return true;
  const loose = looseText(sent);
  return loose.length > 0 && looseText(recorded).includes(loose);
}

function looseText(text: string): string {
  return text.replace(/[\s\u200d\ufe0e\ufe0f\ufffd]|[\u{10000}-\u{10ffff}]|[\ud800-\udfff]/gu, "");
}

/**
 * 旁路报来一轮结束：这一轮开始前发出的话 CLI 已经收下（非排队的在开始后 2 秒内发出也算——发送回执可能晚于回合开始事件），
 * 剩下的才接着等。不靠比原文：原文对不上时（见 userTextRecorded）聊天层原先一直等。
 * 排队的（上一轮还在跑时发的）必须早于这一轮开始，否则是等下一轮的
 */
export function pendingAfterTurn(
  pending: readonly ChatMessageDto[],
  turnStartedAt: number,
  slackMs = 2000,
): ChatMessageDto[] {
  return pending.filter((message) => {
    const at = Date.parse(message.timestamp ?? "");
    if (!Number.isFinite(at)) return true;
    return message.queued ? at >= turnStartedAt : at > turnStartedAt + slackMs;
  });
}

/** 斜杠发出后要不要露出 TUI：无参 /model、/models、/login 会唤选择器或登录页 */
export function slashHandoff(
  text: string,
  modelSwitchKind: "direct" | "picker" | null,
): ChatHandoffEvent {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const cmd = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const hasArgs = space >= 0 && trimmed.slice(space).trim().length > 0;
  if (cmd === "/login" || cmd === "/models") return "picker_model";
  if (cmd === "/model" && (!hasArgs || modelSwitchKind === "picker")) {
    return "picker_model";
  }
  return "direct_slash";
}

export function chatMessageKey(
  message: Pick<ChatMessageDto, "role" | "blocks" | "timestamp" | "id">,
): string {
  if (message.id) return `${message.role}:id:${message.id}`;
  const firstText = message.blocks.find((block) => block.kind === "text")?.text ?? "";
  return `${message.role}:${message.timestamp ?? ""}:${message.blocks.length}:${firstText.slice(0, 24)}`;
}

/** 向前翻页时把旧窗接到最新窗前面，按内容键去重（最新窗优先） */
export function mergeConversationPages(
  older: ChatMessageDto[],
  latest: ChatMessageDto[],
): ChatMessageDto[] {
  const seen = new Set(latest.map(chatMessageKey));
  const head = older.filter((message) => !seen.has(chatMessageKey(message)));
  return [...head, ...latest];
}

/**
 * 把会话文件还没记下的本地消息放回解析结果里（聊天层乐观显示）。排队中的（上一轮还在生成时发的）
 * 一律接在末尾；其余插在「发送之后才出现的第一条回复」前面——后端暂时只解析到回复时阅读顺序仍对。
 * knownReplyKeys = 发送那一刻已有的回复（messageKey：有 id 用 id，否则按内容）。原先插在整页第一条回复前，
 * 长对话里刚发的那句会跳到页顶（2026-10-18 修）。
 */
/** 消息身份：来源给了 id 就用 id（同样一句「好的」也分得开），没有就按内容 */
export function messageKey(message: ChatMessageDto): string {
  return message.id ? `id:${message.id}` : JSON.stringify(message.blocks);
}

export function placePendingUsers(
  parsed: ChatMessageDto[],
  missing: ChatMessageDto[],
  knownReplyKeys: ReadonlySet<string>,
): ChatMessageDto[] {
  if (missing.length === 0) return parsed;
  const next = [...parsed];
  const replyIndex = next.findIndex(
    (message) => message.role !== "user" && !knownReplyKeys.has(messageKey(message)),
  );
  next.splice(replyIndex < 0 ? next.length : replyIndex, 0, ...missing.filter((m) => !m.queued));
  next.push(...missing.filter((m) => m.queued));
  return next;
}

/** kimi /model 吃的是别名：非法字符清洗为 _，与状态栏 / global_config 同规则 */
export function kimiModelArg(model: string): string {
  return model.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function modelSwitchCommand(
  template: string,
  model: string,
  agentId: string | null | undefined,
): string {
  const arg = agentId === "kimi" ? kimiModelArg(model) : model;
  return template.replace("{model}", arg);
}
