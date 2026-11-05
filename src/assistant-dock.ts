/**
 * 项目助手常驻侧栏（2026-11-05 用户拍板「右侧常驻侧栏」）的纯逻辑：宽度夹紧、够不够宽常驻、提问时「用户此刻在看哪」。
 * 宿主 ProjectAssistantHost 量主区宽度、读 store，这里只算；配 tests/assistant-dock.test.ts。
 */
import { projectTaskLabel, type ProjectSurfaceTab } from "./project-surface.ts";

export const ASSISTANT_WIDTH_DEFAULT = 420;
export const ASSISTANT_WIDTH_MIN = 340;
export const ASSISTANT_WIDTH_MAX = 640;
/** 常驻时主区至少还要留这么宽，不然退回浮层抽屉（页面被挤得没法看） */
export const DOCK_MIN_MAIN_PX = 720;
export const ASSISTANT_WIDTH_KEY = "ccode.assistant.width";

/** 拖出来的宽度夹进 340–640；负数 = 双击恢复默认 */
export function clampAssistantWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0) return ASSISTANT_WIDTH_DEFAULT;
  return Math.round(Math.min(ASSISTANT_WIDTH_MAX, Math.max(ASSISTANT_WIDTH_MIN, width)));
}

/** 主区（加上侧栏现在占的宽）减去侧栏宽，还够不够看 */
export function canDockAssistant(mainWithDock: number, width: number): boolean {
  return mainWithDock - width >= DOCK_MIN_MAIN_PX;
}

const PAGE_LABEL: Record<string, string> = {
  workbench: "工作台",
  workspaces: "项目页",
  terminal: "对话页",
  sessions: "对话管理",
  stats: "用量页",
  settings: "设置页",
  profiles: "连接页",
  skills: "技能页",
  mcp: "MCP 页",
};

function tabLabel(tab: ProjectSurfaceTab, workMode: string | null | undefined): string {
  if (tab === "tasks") return projectTaskLabel(workMode);
  if (tab === "schedules") return "定时任务";
  if (tab === "files") return "文件";
  return "Agent 分工";
}

/**
 * 提问时附上的「用户此刻在看哪」：「项目页 · HER催化综述 ·「定时任务」页签」「工作台」。
 * 只在看的就是这个项目时写页签与聚焦的步骤；看着别的项目时写明是别的项目，免得 AI 把截图当成这个项目的
 */
export function assistantWhere(input: {
  page: string;
  assistantProject: string;
  /** 项目页此刻展示的项目（store.contextLabel）；不在项目页时可能是上次看的 */
  viewing: { project: string; samePath: boolean; step: string | null } | null;
  tab: ProjectSurfaceTab | null;
  workMode?: string | null;
}): string {
  const page = PAGE_LABEL[input.page] ?? input.page;
  if (input.page !== "workspaces" || !input.viewing) return page;
  if (!input.viewing.samePath) return `${page} · 别的项目「${input.viewing.project}」（不是正在问的「${input.assistantProject}」）`;
  const parts = [page, `「${input.viewing.project}」`];
  if (input.tab) parts.push(`「${tabLabel(input.tab, input.workMode)}」页签`);
  if (input.viewing.step) parts.push(`聚焦在步骤「${input.viewing.step}」`);
  return parts.join(" · ");
}
