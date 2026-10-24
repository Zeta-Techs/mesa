/**
 * 「启动时进入」（设置 → 通用）的纯逻辑。2026-10-24 用户：「应该是工作台、上次会话、上次的项目、新会话」——
 * 原先是九个页面任选，侧栏改版后「运行」「对话」这些页单独当落脚点没意义，改成四种去处。
 * 存在 settings.startPage（后端 settings.rs KNOWN_START_PAGES 白名单，两边同步）；旧值（页面 id）一律当工作台。
 */

import { pathWithin } from "./path-utils.ts";

export const START_PAGE_OPTIONS = [
  { id: "workbench", label: "工作台" },
  { id: "last-chat", label: "上次的对话" },
  { id: "last-project", label: "上次的项目" },
  { id: "new-chat", label: "新对话" },
] as const;

export type StartPageId = (typeof START_PAGE_OPTIONS)[number]["id"];

/** 「上次的项目」= 最后看的那段对话所在的项目（2026-10-24 用户选定，不是最后看的项目页）：
 *  App 在运行页正看着一段对话、它的目录落在某个已添加项目里时记下项目根 */
export const LAST_PROJECT_KEY = "ccode.lastProject";

/** 对话目录属于哪个已添加项目：落在多个里（项目套项目）取最深的那个；都不在返回 null（随手聊、主目录里的终端） */
export function projectOfCwd(
  cwd: string,
  projectPaths: readonly string[],
  isWindows = false,
): string | null {
  let best: string | null = null;
  for (const p of projectPaths) {
    if (pathWithin(cwd, p, isWindows) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

export function normalizeStartPage(value: unknown): StartPageId {
  return START_PAGE_OPTIONS.some((o) => o.id === value) ? (value as StartPageId) : "workbench";
}

export type StartAction =
  | { kind: "workbench" }
  /** 运行页：重启后它只摆回上次正看着的那段（恢复占位，发一句才接回） */
  | { kind: "last-chat" }
  /** 项目页；path 为空 = 不指定，项目页按自己的默认选第一个 */
  | { kind: "project"; path: string | null }
  | { kind: "new-chat" };

/**
 * 去哪：上次的对话没有可回的（上次把对话都关了）回工作台；上次的项目记的那个已移除就退到项目页默认，
 * 一个项目都没有回工作台。新对话不看别的条件
 */
export function resolveStartAction(
  value: unknown,
  ctx: { hasLastChat: boolean; lastProjectPath: string | null; projectPaths: readonly string[] },
): StartAction {
  switch (normalizeStartPage(value)) {
    case "last-chat":
      return ctx.hasLastChat ? { kind: "last-chat" } : { kind: "workbench" };
    case "last-project": {
      if (ctx.projectPaths.length === 0) return { kind: "workbench" };
      const known = ctx.lastProjectPath && ctx.projectPaths.includes(ctx.lastProjectPath);
      return { kind: "project", path: known ? ctx.lastProjectPath : null };
    }
    case "new-chat":
      return { kind: "new-chat" };
    default:
      return { kind: "workbench" };
  }
}
