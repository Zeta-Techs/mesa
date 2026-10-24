import type { LucideIcon } from "lucide-react";
import { NAV_ICONS } from "./navigation-icons";

export type NavItem = {
  id: string;
  /** 入口名（同侧栏上的字） */
  label: string;
  /** 停在这一页时报的页名（灵动岛休眠面）；入口名是动作时才写（「搜对话」→「对话」） */
  page?: string;
  Icon: LucideIcon;
};

/** 导航清单单一出处（2026-10-16 侧栏工作台化后口径）：
 *  侧栏本身不按本表渲染（App.tsx 自排：快速入口 + 项目树 + 系统段），
 *  本表供隐藏态导航胶囊（TopNavCapsule）、设置页「岛上显示的入口」消费，保持全量九页。
 *  2026-10-24 侧栏改版后顺序与字同图标态侧栏：工作台 ·（新对话）· 运行 · 搜对话 · 项目；新对话不是页，岛上插在工作台后面 */
export const NAV_GROUPS = [
  {
    label: "工作",
    items: [
      { id: "workbench", label: "工作台", Icon: NAV_ICONS.workbench },
      { id: "terminal", label: "运行", Icon: NAV_ICONS.terminal },
      { id: "sessions", label: "搜对话", page: "对话", Icon: NAV_ICONS.sessions },
      { id: "workspaces", label: "项目", Icon: NAV_ICONS.workspaces },
    ],
  },
  {
    label: "资源",
    items: [
      { id: "profiles", label: "连接", Icon: NAV_ICONS.profiles },
      { id: "skills", label: "技能", Icon: NAV_ICONS.skills },
      { id: "mcp", label: "MCP", Icon: NAV_ICONS.mcp },
    ],
  },
] as const satisfies readonly { label: string; items: readonly NavItem[] }[];

export const NAV_BOTTOM = [
  { id: "stats", label: "用量", Icon: NAV_ICONS.stats },
  { id: "settings", label: "设置", Icon: NAV_ICONS.settings },
] as const satisfies readonly NavItem[];
