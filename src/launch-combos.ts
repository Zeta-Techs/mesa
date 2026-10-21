/**
 * 聊天输入框「模型」菜单顶上的「最近在这个项目用过」（docs/design-chat-composer-mockup.html ③，2026-10-22）：
 * Mesa 底下是九家 Agent × 多条连接，用户反复换的其实是一整套搭配（Agent + 连接 + 模型 + 思考档）。
 * 每次从聊天层开聊记一套，按工作目录分开存，最多 3 套；点一下四样一起换。
 * 只存 id 与模型名（不存密钥），本机 localStorage；连接被删的搭配由调用方过滤掉不显示。
 */

export interface LaunchCombo {
  agentId: string;
  profileId: string;
  /** 空串 = 用连接名单第一个 */
  model: string;
  /** 空串 = 按连接设置 */
  effort: string;
}

export const COMBO_LIMIT = 3;
/** 记多少个目录的搭配：再多就丢最久没用的目录 */
const DIR_LIMIT = 40;
const STORAGE_KEY = "ccode.chatCombos";

type ComboStore = Record<string, { at: number; combos: LaunchCombo[] }>;

/** 目录键：去掉末尾分隔符；Windows 不分大小写 */
export function comboDirKey(cwd: string, isWindows = false): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, "") || cwd.trim();
  return isWindows ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

export function sameCombo(a: LaunchCombo, b: LaunchCombo): boolean {
  return a.agentId === b.agentId && a.profileId === b.profileId && a.model === b.model && a.effort === b.effort;
}

/** 把这一套放到最前，同样的一套只留一条 */
export function rememberCombo(list: readonly LaunchCombo[], combo: LaunchCombo, limit = COMBO_LIMIT): LaunchCombo[] {
  return [combo, ...list.filter((c) => !sameCombo(c, combo))].slice(0, limit);
}

/** 存储里记一套（纯函数：返回新存储）；目录超过上限时丢最久没用的 */
export function recordComboIn(store: ComboStore, dir: string, combo: LaunchCombo, now: number): ComboStore {
  const next: ComboStore = { ...store, [dir]: { at: now, combos: rememberCombo(store[dir]?.combos ?? [], combo) } };
  const dirs = Object.keys(next);
  if (dirs.length > DIR_LIMIT) {
    dirs
      .sort((a, b) => next[a].at - next[b].at)
      .slice(0, dirs.length - DIR_LIMIT)
      .forEach((d) => delete next[d]);
  }
  return next;
}

function readStore(): ComboStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as ComboStore) : {};
  } catch {
    return {};
  }
}

export function readCombos(cwd: string, isWindows = false): LaunchCombo[] {
  if (!cwd.trim()) return [];
  const list = readStore()[comboDirKey(cwd, isWindows)]?.combos;
  return Array.isArray(list) ? list.filter((c) => c && typeof c.agentId === "string" && typeof c.profileId === "string") : [];
}

export function recordCombo(cwd: string, combo: LaunchCombo, isWindows = false): void {
  if (!cwd.trim() || !combo.agentId || !combo.profileId) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recordComboIn(readStore(), comboDirKey(cwd, isWindows), combo, Date.now())));
  } catch {
    // 存不下只是少了「最近用过」，不打扰用户
  }
}
