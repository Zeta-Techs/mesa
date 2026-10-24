export const TERMINAL_TABS_STORAGE_KEY = "ccode.terminalTabs.v1";

const MAX_TABS = 24;
const AGENT_IDS = new Set(["claude-code", "codex", "gemini", "qwen", "opencode", "kimi", "codebuddy", "cursor", "grok"]);

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
  }));
  const activeIndex = tabs.length > 0
    ? Math.min(Math.max(Math.trunc(state.activeIndex), 0), tabs.length - 1)
    : 0;
  return JSON.stringify({ version: 1, tabs, activeIndex });
}
