import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Blocks,
  Cable,
  Clock3,
  Folder,
  FolderPlus,
  LayoutDashboard,
  MessageCirclePlus,
  MessagesSquare,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
} from "lucide-react";

export const NAV_ICONS = {
  workbench: LayoutDashboard,
  workspaces: Folder,
  terminal: SquareTerminal,
  sessions: MessagesSquare,
  profiles: Cable,
  skills: Sparkles,
  mcp: Blocks,
  schedules: Clock3,
  stats: BarChart3,
  settings: Settings2,
  quickChat: MessageCirclePlus,
  // 侧栏顶部「新项目」与标题栏「搜索对话和项目」（2026-10-27）
  newProject: FolderPlus,
  search: Search,
} satisfies Record<string, LucideIcon>;

export type NavIconId = keyof typeof NAV_ICONS;
