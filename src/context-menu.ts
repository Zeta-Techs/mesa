/**
 * 右键 / ⋯ 菜单的条目形状与渲染前整理（纯逻辑，ContextMenu.tsx 渲染；tests/context-menu.test.ts）。
 */
import type { LucideIcon } from "lucide-react";

export interface ContextMenuItem {
  label?: string;
  onSelect?: () => void;
  /** 行首图标（Lucide，13px 线框与全站同口径）；菜单里任一项带图标或状态点才留图标列 */
  icon?: LucideIcon;
  /** 行尾弱化提示（快捷键、计数、去向等短词），不放说明句——说明进 title */
  hint?: string;
  /** 禁用项：渲染为不可点，title 说明原因（如互斥脚本运行中） */
  disabled?: boolean;
  /** 危险项：红色警示文字（删除类不可逆操作）；与前面的普通项之间自动补分隔线 */
  danger?: boolean;
  /** 当前项：行底 bg-hover text-l1 + 行尾 Check，形态与 LaunchMenu 选中行一致 */
  checked?: boolean;
  /** 分组小标题（不可点）：段头与首行同现，替代裸分隔线；文字弱化同左栏组头 */
  header?: string;
  /** 行首状态点（与图标同列）：warn=待处理 / running=运行中，词表与 projectRailStatus 同款 */
  mark?: "warn" | "running";
  title?: string;
  separator?: boolean;
}

/** 渲染前整理条目：危险项与前面的普通项之间补分隔线（全站删除类动作自动成组，
 *  调用方不必各自记得加）；连续分隔线合一、首尾分隔线去掉（条件拼装的菜单常留空段）。 */
export function normalizeMenuItems(items: ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.separator) {
      if (prev && !prev.separator) out.push(it);
      continue;
    }
    if (it.danger && prev && !prev.separator && !prev.danger && !prev.header) {
      out.push({ separator: true });
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}
