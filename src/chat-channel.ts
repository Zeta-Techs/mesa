/**
 * 聊天层结构化旁路（docs/design-chat-structured-channels.md）的前端纯逻辑：后端 chat_channel.rs 把各家 CLI 自己吐的
 * 结构化事件统一成一份快照（`chat-channel-<tabId>` 事件），这里把它翻成聊天层要的东西——跟着换会话文件、
 * 回合状态 → 标签注意力、实时文字、「等你决定」卡的内容与按钮。
 *
 * 优先级：旁路说了算的事，读会话文件 / 读屏的推断只补空缺（旁路没接上的家照旧走原来那套）。
 */
import { samePath } from "./path-utils.ts";
import { lineDiff, parsePatch, unwrapPowerShell, type DiffLine } from "./tool-activity.ts";

/** program-status = CLI 自己写进终端流的程序状态（OSC 7501，program_status.rs）：没有别的旁路时用，2026-10-22 起 Grok */
export type ChannelKind = "hooks" | "qwen" | "opencode" | "codex" | "program-status" | "acp" | "claude-native";

/**
 * 这条旁路的审批只是「在等确认」的信号，答不了、也不带菜单（hooks、程序状态）：卡片按屏上菜单原文给按钮，
 * 答了没有由屏上输入框回来判断
 */
export function channelInfersApproval(snap: Pick<ChatChannelSnapshot, "kind"> | null | undefined): boolean {
  return snap?.kind === "hooks" || snap?.kind === "program-status";
}

export interface ChannelTurn {
  seq: number;
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  stopReason: string | null;
  error?: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface ChannelApproval {
  requestId: string | null;
  /** 可经 CLI 官方通道从聊天层答（Qwen / OpenCode / Codex）；false = 只能在终端菜单里答 */
  replyable: boolean;
  toolName: string | null;
  kind: "execute" | "edit" | "read" | "fetch" | "other";
  command: string | null;
  path: string | null;
  oldText: string | null;
  newText: string | null;
  diff: string | null;
  detail: string | null;
  alwaysLabel: string | null;
  /** Claude 计划模式出完方案、问要不要开工（ExitPlanMode）时的方案原文（Markdown）；旧版后端没有这个字段 */
  plan?: string | null;
  /** 原生模式 Claude 的提问表单（AskUserQuestion 的 questions 原样，native-ask.ts 解析） */
  questions?: unknown;
}

export interface ChannelFallback {
  kind: "auth" | "compat";
  reason: string;
}

export interface ChatChannelSnapshot {
  tabId: string;
  agent: string;
  kind: ChannelKind;
  connection?: "connecting" | "connected" | "disconnected" | null;
  sessionId: string | null;
  transcriptPath: string | null;
  sessionSeq: number;
  sessionSource: string | null;
  turn: ChannelTurn | null;
  approval: ChannelApproval | null;
  liveText: string | null;
  notice: { seq: number; text: string } | null;
  /** 原生模式启动阶段失败时通知前端自动回落（auth 引去登录 / compat 自动改用兼容模式重开） */
  fallback?: ChannelFallback | null;
  /** 正在跑的工具（最近开始、还没结束的那个；input 是参数 JSON，已截断脱敏）；没有为 null */
  activity: { name: string; input: string; startedAt: number } | null;
  /** 这一段思考的摘要（Codex 推理摘要、Qwen / OpenCode 思考增量）；工具开始或正文开始写就清掉 */
  thinking: string | null;
  /** CLI 自己报的一句现状（程序状态旁路的 msg，如 Grok「Connection failed | Retrying (1/15)」）；回合开始 / 结束清掉 */
  statusLine?: string | null;
  retry?: string | null;
  /** 结构化通道（ACP / Claude 原生 / Codex / Qwen / OpenCode）这一段思考的实时原文（最近一截，已脱敏）：正文出来前照思考预览框流式显示；旧版后端没有 */
  thinkingLive?: string | null;
  /** 这个进程里起过几个后台任务（run_in_background 的命令 / 子 Agent、Claude 的 Monitor）；看不到工具参数的旁路为 0；旧版后端没有 */
  backgroundStarted?: number;
  /** 这条旁路能不能替聊天层发话（后端按家与版本定：Codex、Qwen、OpenCode 1.x、原生模式的 Kimi / Claude）；旧版后端没有这个字段 */
  canSend?: boolean;
}

export type ChannelReplyDecision = "allow" | "allow_always" | "deny";

export function channelTurnOpen(snap: ChatChannelSnapshot | null): boolean {
  if (snap?.connection === "disconnected") return false;
  const s = snap?.turn?.status;
  return s === "running" || s === "awaiting_approval";
}

/**
 * 原生模式切换（停下进程按会话接回）前确认框里的提醒：看得到工具参数的旁路按这个进程起过的后台任务说，一个没起过就不提；
 * 看不到的（程序状态、读屏）照旧泛泛提醒一句
 */
export function nativeSwitchWarning(snap: ChatChannelSnapshot | null | undefined): string | null {
  const knows = !!snap && (snap.kind === "acp" || snap.kind === "claude-native" || snap.kind === "hooks");
  const n = snap?.backgroundStarted ?? 0;
  if (knows && n === 0) return null;
  if (knows) return `注意：这段对话里起过 ${n} 个后台任务（后台命令或子 Agent），切换会一起停掉。`;
  return "注意：它在后台跑着的命令会一起停掉。";
}

/** 纯协议运行时的旁路（原生模式的 Kimi ACP、Claude -p 双向 stream-json）：没有终端界面，发话只能经通道 */
export function nativeRuntimeKind(kind: ChannelKind | null | undefined): boolean {
  return kind === "acp" || kind === "claude-native";
}

/** 原生模式启动阶段自动回落的单次护栏：每个标签一次启动最多自动回落一次，避免失败死循环 */
export function decideNativeFallback(
  snap: Pick<ChatChannelSnapshot, "fallback"> | null | undefined,
  alreadyUsed: boolean,
): ChannelFallback | null {
  if (alreadyUsed || !snap?.fallback) return null;
  return snap.fallback;
}

/**
 * 原生模式下能经官方协议「原地热切、不重启进程」的权限档（与 switch-strategy InSessionPermission 同形）：
 * - Kimi ACP（2.8.0 实测）：session/set_mode 支持 default / auto / yolo 三档原地热切
 * - Claude 原生（2.1.326 实测）：set_permission_mode 支持 default / auto 原地热切；
 *   bypassPermissions 未带 --dangerously-skip-permissions 启动会被拒（bypass_not_launched），切完全访问照旧走重开
 */
export function nativeInlinePermissionSpec(
  kind: ChannelKind | null | undefined,
  agentId: string | null | undefined,
): { command: string; args: Partial<Record<"ask" | "auto" | "full", string>>; midTurn: "now" } | null {
  if (kind === "acp" && agentId === "kimi") {
    return { command: "", args: { ask: "default", auto: "auto", full: "yolo" }, midTurn: "now" };
  }
  if (kind === "acp" && agentId === "codebuddy") {
    return { command: "", args: { ask: "default", auto: "auto", full: "bypassPermissions" }, midTurn: "now" };
  }
  if (kind === "acp" && agentId === "gemini") {
    return { command: "", args: { ask: "default", full: "yolo" }, midTurn: "now" };
  }
  if (kind === "acp" && agentId === "agy") {
    return { command: "", args: { ask: "default" }, midTurn: "now" };
  }
  if (kind === "claude-native") {
    return { command: "", args: { ask: "default", auto: "auto" }, midTurn: "now" };
  }
  return null;
}

export interface InterruptRoute {
  viaChannel: boolean;
  sessionId: string | null;
}

/**
 * 点「停止」时走官方停止接口还是往终端发 Esc：必须按**当前进程的实际形态**判，不能只看开关——
 * 回合中翻完原生开关还没空闲重开时，开关与实际进程暂时不一致。
 * Claude 原生首句还没报出 sessionId 时给空串，后端同样放行 interrupt。
 */
export function interruptRoute(opts: {
  agentId: string | null | undefined;
  nativeMode: boolean;
  actualNativeRuntime: boolean;
  splitRuntimeAgent: boolean;
  stopViaChannel: boolean;
  channel: ChatChannelSnapshot | null | undefined;
}): InterruptRoute {
  const snap = opts.channel;
  if (opts.actualNativeRuntime || nativeRuntimeKind(snap?.kind)) {
    return {
      viaChannel: true,
      sessionId: snap?.kind === "claude-native" ? (snap.sessionId ?? "") : (snap?.sessionId ?? null),
    };
  }
  if (opts.agentId === "opencode") {
    return { viaChannel: true, sessionId: snap?.sessionId ?? null };
  }
  if (opts.splitRuntimeAgent) {
    return { viaChannel: false, sessionId: null };
  }
  if (opts.nativeMode && opts.stopViaChannel) {
    return { viaChannel: true, sessionId: snap?.sessionId ?? null };
  }
  return { viaChannel: false, sessionId: null };
}

/** 原生模式下这句该不该经通道发：斜杠 / ! 命令是终端自己的功能，照旧打进终端 */
export function wantsChannelSend(native: boolean, message: string): boolean {
  return native && !/^[/!]/.test(message.trim());
}

/**
 * 原生模式这句能不能经通道发出（chat_channel_send）：Codex 的私有服务连着、已认出这段对话。
 * 这一轮还在跑也走通道：后端改发 turn/steer 插进这一轮（同终端里回合中按回车）。
 * 不行就照旧打进终端（还没认出对话的第一句、通道断了），不丢这句
 */
export function canSendViaChannel(snap: ChatChannelSnapshot | null | undefined): boolean {
  if (!snap?.canSend || snap.connection === "disconnected") return false;
  // Qwen 是命令文件，没有连接状态；Claude 的会话 id 在第一句之后才报（没带 --session-id 时），连着就能发
  if (snap.kind === "qwen") return true;
  if (snap.connection !== "connected") return false;
  if (snap.kind === "claude-native") return true;
  return !!snap.sessionId;
}

/** 旁路的回合状态 → 标签注意力（working / confirm / done）；旁路没说过就 null（交回原来的推断） */
export function channelAttention(snap: ChatChannelSnapshot | null): "working" | "confirm" | "done" | null {
  if (snap?.connection === "disconnected") return null;
  const t = snap?.turn;
  if (!t) return null;
  if (t.status === "running") return "working";
  if (t.status === "awaiting_approval") return "confirm";
  return "done";
}

/**
 * 「终端静了、屏上认不出输入框」能不能当成在等人（「终端在等你」通用卡）。CLI 自己报过这一轮已结束（hooks 的 Stop、
 * 程序状态 OSC 7501 的 idle / done、Codex / Qwen / OpenCode 旁路的回合结束）就不能：它真停在要人处理的画面上会报等确认，读屏猜的不比它准。
 * 2026-11-25 用户实测：Claude 答完、输入框好好在屏底，读屏没认出来，一从终端切回聊天层就弹卡，卡上是回复正文。
 * 旁路没报过回合（还没开聊：配色、登录、启动菜单）、断了、回合还开着时照旧按读屏判断。
 * 回合结束后又从聊天层发过东西（sentAt 晚于 endedAt）也照旧读屏：/config、/mcp 这类斜杠命令在终端里开全屏画面，
 * 不算新的一轮、旁路一直停在「已结束」
 */
export function quietScreenMayBeWaiting(snap: ChatChannelSnapshot | null | undefined, sentAt = 0): boolean {
  if (!snap || snap.connection === "disconnected") return true;
  const t = snap.turn;
  if (!t || !(t.status === "completed" || t.status === "failed" || t.status === "cancelled")) return true;
  return sentAt > (t.endedAt ?? 0);
}

/**
 * hooks 家（Claude Code）的审批答完了没有：CLI 不报「答了」，旁路要等那个工具跑完（PostToolUse）才撤卡，
 * 批准后工具跑多久「等你确认」就挂多久——卡片从终端菜单的英文原文换成一张中文的「要访问网络」，
 * 标签黄点也一直亮着（2026-10-20 用户 Windows 实测：WebFetch 批准后又挂了 14 秒；Windows 上 hooks 在后台跑，
 * 快命令也要多挂约 1 秒，Mac 上慢命令同样如此）。
 * promptIdle = 最近一次扫屏看见这家的输入框、没有菜单：终端里已经不在等这一问（在聊天层点的、在终端里答的都算）。
 * 读屏认不出输入框的家（CodeBuddy）promptIdle 恒为 false，照旧等旁路撤卡；能从聊天层答的（Qwen / Codex）不经这里
 */
export function hooksApprovalAnswered(snap: ChatChannelSnapshot | null, promptIdle: boolean): boolean {
  return Boolean(
    promptIdle &&
      channelInfersApproval(snap) &&
      snap?.turn?.status === "awaiting_approval" &&
      !snap.approval?.replyable,
  );
}

/**
 * 旁路告诉的会话与聊天层现在盯的文件对不上时怎么办：
 * - lock：还没认出会话文件，旁路直接给了路径 → 按它锁定（不再按目录排队猜）
 * - switch：已经盯着一个文件，CLI 换了会话（/clear、恢复别的会话）→ 改盯新文件
 * - hint：只给了会话 id（Qwen / OpenCode）→ 交给按 id 找文件
 */
export function channelRelink(
  snap: ChatChannelSnapshot | null,
  current: { filePath: string | null; hint: string | null; seenSeq: number; sessionId?: string | null },
  isWindows: boolean,
): { kind: "none" } | { kind: "lock" | "switch"; path: string; sessionId: string | null } | { kind: "hint"; sessionId: string } {
  if (!snap || snap.connection === "disconnected") return { kind: "none" };
  if (snap.transcriptPath) {
    if (!current.filePath) return { kind: "lock", path: snap.transcriptPath, sessionId: snap.sessionId };
    if (snap.sessionSeq > current.seenSeq && !samePath(snap.transcriptPath, current.filePath, isWindows)) {
      return { kind: "switch", path: snap.transcriptPath, sessionId: snap.sessionId };
    }
    return { kind: "none" };
  }
  if (snap.sessionId && (
    (!current.filePath && current.hint !== snap.sessionId) ||
    (current.filePath && snap.sessionSeq > current.seenSeq && snap.sessionId !== (current.sessionId ?? current.hint))
  )) {
    return { kind: "hint", sessionId: snap.sessionId };
  }
  return { kind: "none" };
}

/** 换会话时对话流里插的一行说明 */
export function sessionSwitchNote(source: string | null): string {
  if (source === "clear") return "已开始新对话（/clear）";
  if (source === "resume") return "已接回另一段对话";
  if (source === "compact") return "上下文已压缩，接着这段对话";
  return "已切到新的会话";
}

/** 旁路本身直接推送流式回复正文的家（Qwen / OpenCode / Codex / 原生 ACP / Claude 原生）；hooks 与 program-status 只报回合/工具/审批状态，正文仍靠读屏实时预览 */
export function channelDeliversLiveText(
  snap: Pick<ChatChannelSnapshot, "kind" | "connection"> | null | undefined,
): boolean {
  if (!snap || snap.connection === "disconnected") return false;
  return (
    snap.kind === "qwen" ||
    snap.kind === "opencode" ||
    snap.kind === "codex" ||
    snap.kind === "acp" ||
    snap.kind === "claude-native"
  );
}

/** 旁路送来的这一轮实时文字（Qwen / OpenCode / Codex）；保留首行缩进（缩进代码块 / 嵌套列表），只去掉开头空行与尾部空白 */
export function channelLiveLines(snap: ChatChannelSnapshot | null): string[] | null {
  if (!snap?.liveText || !snap.turn || snap.connection === "disconnected") return null;
  if (!snap.liveText.trim()) return null;
  const text = snap.liveText.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
  return text ? text.split(/\r?\n/) : null;
}

export type DecisionPreview =
  | { kind: "command"; text: string }
  | { kind: "diff"; path: string | null; lines: DiffLine[] }
  | { kind: "text"; text: string };

/** 审批卡上画什么：命令原文 / 要改的差异 / 参数原文 */
export function approvalPreview(a: ChannelApproval | null): DecisionPreview | null {
  if (!a) return null;
  if (a.command) return { kind: "command", text: displayCommand(a.command) };
  if (a.diff) {
    const files = parsePatch(a.diff);
    const lines = files.length ? files.flatMap((f) => f.lines) : diffTextLines(a.diff);
    return { kind: "diff", path: a.path, lines };
  }
  if (a.oldText !== null || a.newText !== null) {
    return { kind: "diff", path: a.path, lines: lineDiff(a.oldText ?? "", a.newText ?? "") };
  }
  if (a.plan) return { kind: "text", text: a.plan };
  if (a.kind === "other" && a.detail) return { kind: "text", text: a.detail };
  return null;
}

/**
 * 命令去掉外层 shell 包装再给人看：Codex 把模型的命令再包一层登录 shell，审批里是
 * `/bin/zsh -lc "/bin/zsh -lc 'printf …'"`（2026-10-20 用户截图）。只剥「整条就是 sh -c 加一个引号串」的；
 * 双引号串里有没转义的 $ 或反引号就不剥（那要外层 shell 先展开，剥了含义会变）。
 * Windows 上包的是 PowerShell：`"D:\…\pwsh.exe" -Command 'echo …'`（同日 Windows 端到端实测），同样剥掉
 */
export function displayCommand(command: string): string {
  let cur = command.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")$/.exec(cur);
    if (!m) {
      const ps = unwrapPowerShell(cur);
      if (ps === null) break;
      cur = ps;
      continue;
    }
    if (m[1] !== undefined) {
      cur = m[1].trim();
    } else {
      if (/(^|[^\\])[$`]/.test(m[2])) break;
      cur = m[2].replace(/\\(["\\$`])/g, "$1").trim();
    }
  }
  return cur;
}

/** 统一差异文本 → 行（没有补丁头的裸差异：+ / - / 空格开头；改多个文件时后端每段前加「*** 路径」，画成分隔） */
function diffTextLines(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("+++") && !l.startsWith("---"))
    .map((l) =>
      l.startsWith("*** ")
        ? { op: "~" as const, text: l.slice(4) }
        : l.startsWith("+")
        ? { op: "+" as const, text: l.slice(1) }
        : l.startsWith("-")
          ? { op: "-" as const, text: l.slice(1) }
          : { op: " " as const, text: l.startsWith(" ") ? l.slice(1) : l },
    );
}

const KIND_TITLE: Record<ChannelApproval["kind"], string> = {
  execute: "要运行一条命令",
  edit: "要改文件",
  read: "要读文件",
  fetch: "要访问网络",
  other: "要用一个工具",
};

/** 卡片标题：「Codex 要运行一条命令」「Claude Code 要改文件 · a.ts」 */
export function approvalTitle(a: ChannelApproval, agentLabel: string): string {
  if (isQuestionApproval(a)) return `${agentLabel} 在等你回答`;
  const name = a.path ? a.path.split(/[\\/]/).pop() : null;
  const base = `${agentLabel} ${KIND_TITLE[a.kind]}`;
  if (a.kind === "edit" && name) return `${base} · ${name}`;
  if (a.toolName === "ExitPlanMode" || a.toolName === "exit_plan_mode" || a.toolName === "plan_exit") return `${agentLabel} 写好了方案，等你决定要不要开工`;
  if (a.kind === "other" && a.toolName) return `${agentLabel} 要用 ${a.toolName}`;
  return base;
}

/** 眼下这一问聊天层卡上就能答（Codex / Qwen / OpenCode 经官方通道）：不必再把终端拉出来 */
export function channelCanAnswer(snap: ChatChannelSnapshot | null, agent: string | null): boolean {
  return Boolean(snap?.connection !== "disconnected" && snap?.approval && approvalChoices(snap.approval, agent).length);
}

/**
 * 终端菜单的选项比旁路能回的多：旁路的卡会少选项，改用照终端原文的菜单卡（按键答，tui-menu.ts）。
 * Qwen 的官方通道只收「允许 / 拒绝」（dual-output confirmation_response 只有 allowed 布尔），终端里却还有
 * 「总是允许…」「Switch to Default Mode and allow once (recommended)」（自动模式分类器不可用时插在拒绝前面）这些——
 * 2026-10-26 用户截图：终端三项、聊天卡只有允许 / 拒绝
 */
export function menuOutgrowsChannel(
  snap: ChatChannelSnapshot | null,
  agent: string | null,
  menuOptions: number,
): boolean {
  if (!snap?.approval) return false;
  const choices = approvalChoices(snap.approval, agent).length;
  // Codex 的第二项可能是命令前缀或网络规则，不能用固定的会话授权替代。
  return choices > 0 && (agent === "codex" ? menuOptions > 0 : menuOptions > choices);
}

/** 可从聊天层答的审批给哪几个按钮（只摆 CLI 支持的，不替用户选） */
export function approvalChoices(
  a: ChannelApproval,
  agent: string | null,
): Array<{ decision: ChannelReplyDecision; label: string; primary?: boolean }> {
  if (!a.replyable || !a.requestId) return [];
  // 后端给了说法（原生模式 ACP 的「本会话都允许」）就用它；OpenCode 另有固定说法
  const always = a.alwaysLabel ?? (agent === "opencode" ? "总是允许这类操作" : null);
  return [
    { decision: "allow", label: "允许", primary: true },
    ...(always ? [{ decision: "allow_always" as const, label: always }] : []),
    { decision: "deny", label: "拒绝" },
  ];
}


/** 本次实际取数来源；能力表描述通常支持什么，不能代替连接状态。 */
export function channelSourceNote(snap: ChatChannelSnapshot | null | undefined): string {
  if (snap?.connection === "disconnected") return "实时通道已断开，当前按会话文件和终端画面更新；实时状态可能延迟，可切到终端继续。";
  if (snap?.connection === "connecting") return "正在连接实时通道，当前按会话文件和终端画面更新。";
  if (!snap) return "本次未接入实时通道，当前按会话文件和终端画面更新。";
  if (nativeRuntimeKind(snap.kind)) return "本次是原生模式：对话、停止和确认都经 CLI 官方协议在聊天里完成；终端页只显示运行日志。";
  if (snap.kind === "hooks") return "本次通过 CLI 事件与会话文件更新；确认选项仍以终端菜单为准。";
  if (snap.kind === "program-status") return "本次通过终端程序状态与会话文件更新。";
  return "本次已接入 CLI 实时通道。";
}


export function isQuestionApproval(a: ChannelApproval | null): boolean {
  return !!a?.toolName && ["requestUserInput", "question", "elicitation"].includes(a.toolName);
}

export function channelOutcome(snap: ChatChannelSnapshot | null | undefined): string | null {
  if (snap?.connection === "disconnected") return null;
  if (snap?.turn?.status === "failed") return `这一轮未完成${snap.turn.error ? `：${snap.turn.error}` : "，可到终端查看原因"}`;
  if (snap?.turn?.status === "cancelled") return "这一轮已中断，可以继续输入。";
  return null;
}

/** Agent 退出（含换权限 / 换模型 / 切原生模式重开）时决定接回哪段会话：
 *  已锁盘直接用；尚未锁盘但通道已找到文件、或本段本就是接回的 / 已经聊过一轮，就回退到通道会话 id 或启动 hint，
 *  避免「刚接回 / 刚发完就重开」把会话清成空白；一句没发的新会话退出仍返回 null，不误亮恢复按钮 */
export function resolveExitResumeSessionId(input: {
  lockedSessionId?: string | null;
  channelSessionId?: string | null;
  channelHasFile?: boolean;
  hint?: string | null;
  resumed?: boolean;
  hadActivity?: boolean;
}): string | null {
  const locked = input.lockedSessionId?.trim();
  if (locked) return locked;
  const chId = input.channelSessionId?.trim();
  const hint = input.hint?.trim();
  if (chId && (input.channelHasFile || input.resumed || input.hadActivity)) return chId;
  if (hint && (input.resumed || input.hadActivity)) return hint;
  return null;
}
