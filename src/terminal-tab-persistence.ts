export const TERMINAL_TABS_STORAGE_KEY = "ccode.terminalTabs.v1";

const MAX_TABS = 24;
const AGENT_IDS = new Set(["claude-code", "codex", "gemini", "qwen", "opencode", "kimi", "codebuddy", "cursor", "grok", "agy"]);

export interface RecoverableTerminalTab {
  id?: string;
  label: string;
  cwd: string;
  agentId: string;
  customRuntimeId?: string | null;
  profileId: string;
  model: string;
  sessionId: string | null;
  runId?: string | null;
  taskId?: string | null;
  /** 只留工作区标签的复用键（ws:<工作树>）：重启后「去终端看看 / 回答」「继续」仍回到这个标签，
   *  不另开一个（2026-10-22 实证：重启后点收件箱「去终端回答」新开了终端）。快速开聊等别的键不留 */
  reuseKey?: string | null;
  /** 分叉标签的原会话 id（2026-10-31）：重启后侧栏照样挂在原对话下面 */
  forkOf?: string | null;
  /** 原生分叉还没落盘（一句没发）：重启后再分一次，不去接那个还不存在的新会话 */
  forkPending?: boolean;
  /** 这段对话开了「原生模式」（2026-11-26，docs/design-chat-native-mode.md）：按对话记，重启后照旧 */
  nativeMode?: boolean;
}

export interface RecoverableTerminalState {
  tabs: RecoverableTerminalTab[];
  activeIndex: number;
}

function textField(value: unknown, max: number, trim = true): string | null {
  if (typeof value !== "string") return null;
  const normalized = trim ? value.trim() : value;
  if (!normalized.trim()) return null;
  return normalized.slice(0, max);
}

function parseTab(value: unknown): RecoverableTerminalTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  const id = textField(tab.id, 80);
  if (id && !/^[A-Za-z0-9-]+$/.test(id)) return null;
  const label = textField(tab.label, 256);
  const cwd = textField(tab.cwd, 4096, false);
  const agentId = textField(tab.agentId, 128);
  const customRuntimeId = textField(tab.customRuntimeId, 128);
  if (!label || !cwd || !agentId || (!AGENT_IDS.has(agentId) && !customRuntimeId)) return null;
  return {
    ...(id ? { id } : {}),
    label,
    cwd,
    agentId,
    ...(customRuntimeId ? { customRuntimeId } : {}),
    profileId: textField(tab.profileId, 256) ?? "",
    model: textField(tab.model, 512) ?? "",
    sessionId: textField(tab.sessionId, 256),
    runId: textField(tab.runId, 64),
    ...(textField(tab.taskId, 64)
      ? { taskId: textField(tab.taskId, 64) }
      : {}),
    ...(workspaceReuseKey(tab.reuseKey) ? { reuseKey: workspaceReuseKey(tab.reuseKey) } : {}),
    ...(textField(tab.forkOf, 256) ? { forkOf: textField(tab.forkOf, 256) } : {}),
    ...(tab.forkPending === true && textField(tab.forkOf, 256) ? { forkPending: true } : {}),
    ...(typeof tab.nativeMode === "boolean" ? { nativeMode: tab.nativeMode } : {}),
  };
}

function workspaceReuseKey(value: unknown): string | null {
  const key = textField(value, 4100, false);
  return key && key.startsWith("ws:") ? key : null;
}

/** 只接受当前版本并逐字段白名单化；损坏或未来版本直接回落为空状态。 */
export function parseRecoverableTerminalState(raw: string | null): RecoverableTerminalState {
  if (!raw) return { tabs: [], activeIndex: 0 };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.version !== 1 || !Array.isArray(value.tabs)) {
      return { tabs: [], activeIndex: 0 };
    }
    const tabs = value.tabs.slice(0, MAX_TABS).map(parseTab).filter((tab) => tab !== null);
    const requested = typeof value.activeIndex === "number" ? Math.trunc(value.activeIndex) : 0;
    return {
      tabs,
      activeIndex: tabs.length > 0 ? Math.min(Math.max(requested, 0), tabs.length - 1) : 0,
    };
  } catch {
    return { tabs: [], activeIndex: 0 };
  }
}

/** 序列化时重新白名单化，调用方即使误传运行时字段也不会写入本地存储。 */
export function serializeRecoverableTerminalState(
  state: RecoverableTerminalState,
): string {
  const tabs = state.tabs.slice(0, MAX_TABS).map((tab) => ({
    ...(tab.id && /^[A-Za-z0-9-]+$/.test(tab.id)
      ? { id: tab.id.slice(0, 80) }
      : {}),
    label: tab.label.slice(0, 256),
    cwd: tab.cwd.slice(0, 4096),
    agentId: tab.agentId.slice(0, 128),
    ...(tab.customRuntimeId
      ? { customRuntimeId: tab.customRuntimeId.slice(0, 128) }
      : {}),
    profileId: tab.profileId.slice(0, 256),
    model: tab.model.slice(0, 512),
    sessionId: tab.sessionId?.slice(0, 256) ?? null,
    runId: tab.runId?.slice(0, 64) ?? null,
    ...(tab.taskId ? { taskId: tab.taskId.slice(0, 64) } : {}),
    ...(workspaceReuseKey(tab.reuseKey) ? { reuseKey: workspaceReuseKey(tab.reuseKey) } : {}),
    ...(tab.forkOf ? { forkOf: tab.forkOf.slice(0, 256) } : {}),
    ...(tab.forkOf && tab.forkPending ? { forkPending: true } : {}),
    ...(typeof tab.nativeMode === "boolean" ? { nativeMode: tab.nativeMode } : {}),
  }));
  const activeIndex = tabs.length > 0
    ? Math.min(Math.max(Math.trunc(state.activeIndex), 0), tabs.length - 1)
    : 0;
  return JSON.stringify({ version: 1, tabs, activeIndex });
}

/**
 * 退出 Mesa 时做到一半的那一轮（2026-11-19）：退出会停掉所有对话，重启只恢复标签、不恢复进程，
 * 被打断的那段对话在标签上看不出来。退出前置信号（`mesa:flush-before-close`，进程还没停）时记下这些标签，
 * 重启后在输入框上挂一行，人点了才接回。只存标签 id，单独一个键，不进上面的白名单。
 */
export const QUIT_CUT_OFF_STORAGE_KEY = "ccode.terminal.quitCutOff.v1";

/** 「让它接着做」发给 Agent 的话：先核对做到哪，不假设上次的进度 */
export const CUT_OFF_CONTINUE_TEXT =
  "上次 Mesa 退出时，你这一轮做到一半被停下了。先看看已经做到哪一步、有没有改到一半的文件，再把这一轮做完。";

export interface CutOffCandidate {
  id: string;
  running: boolean;
  shell: boolean;
  attention: "done" | "working" | "confirm" | null;
  /** 有能接回的会话（没有就算记下也接不回） */
  hasSession: boolean;
  /** 上次退出时就被打断、这次还没接回也没被人收起的 */
  carried: boolean;
}

/** 这次退出会打断的：正在做 / 等你确认的那一轮，加上上次被打断、还没处理的 */
export function pickCutOffTabs(tabs: CutOffCandidate[]): string[] {
  return tabs
    .filter((t) => t.hasSession && !t.shell)
    .filter((t) => (t.running ? t.attention === "working" || t.attention === "confirm" : t.carried))
    .map((t) => t.id);
}

export function serializeQuitCutOff(tabIds: string[]): string {
  return JSON.stringify({ version: 1, tabIds: tabIds.filter((id) => /^[A-Za-z0-9-]{1,80}$/.test(id)).slice(0, MAX_TABS) });
}

export function parseQuitCutOff(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.version !== 1 || !Array.isArray(value.tabIds)) return new Set();
    return new Set(
      value.tabIds
        .slice(0, MAX_TABS)
        .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(id)),
    );
  } catch {
    return new Set();
  }
}
