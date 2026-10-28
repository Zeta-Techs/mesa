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
  Settings,
  SquareTerminal,
  Wand2,
} from "lucide-react";

export const NAV_ICONS = {
  workbench: LayoutDashboard,
  workspaces: Folder,
  terminal: SquareTerminal,
  sessions: MessagesSquare,
  profiles: Cable,
  // 技能用魔杖、设置用齿轮（2026-10-28）：星光在 AI 应用里读作「AI 生成」，滑杆易读成筛选
  skills: Wand2,
  mcp: Blocks,
  schedules: Clock3,
  stats: BarChart3,
  settings: Settings,
  quickChat: MessageCirclePlus,
  // 侧栏顶部「新项目」与标题栏「搜索对话和项目」（2026-10-27）
  newProject: FolderPlus,
  search: Search,
} satisfies Record<string, LucideIcon>;

export type NavIconId = keyof typeof NAV_ICONS;
