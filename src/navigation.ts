import type { LucideIcon } from "lucide-react";
import { NAV_ICONS } from "./navigation-icons";

export type NavItem = {
  id: string;
  label: string;
  Icon: LucideIcon;
};

/** 导航清单单一出处（2026-10-16 侧栏工作台化后口径）：
 *  侧栏本身不按本表渲染（App.tsx 自排：快速入口 + 项目树 + 系统段），
 *  本表供隐藏态导航胶囊（TopNavCapsule）、设置页「导航项目」与快捷键页序消费，保持全量九页。 */
export const NAV_GROUPS = [
  {
    label: "工作",
    items: [
      { id: "workbench", label: "工作台", Icon: NAV_ICONS.workbench },
      { id: "workspaces", label: "项目", Icon: NAV_ICONS.workspaces },
      { id: "terminal", label: "运行", Icon: NAV_ICONS.terminal },
      { id: "sessions", label: "对话", Icon: NAV_ICONS.sessions },
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
