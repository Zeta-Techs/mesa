/**
 * 打开一段对话时先显示聊天层还是终端（2026-10-22，tests/tab-surface.test.ts）。
 *
 * 设置「打开对话时先显示」（`openSurface`，缺省聊天）管所有进入 Agent 对话的入口：问 AI、开始、跟 AI 商量、聊想法、
 * 继续、对话页接着聊、接力、精读。不跟设置走的只有两类，入口自己在 pendingTerminal 上写死 `surface`：
 * 「新对话」固定聊天（选 Agent / 模型就在聊天空态里）；没有对话可看的固定终端（登录、更新、run 脚本、
 * MCP 登录、自定义运行时、「去终端看看」）。切回已经开着的标签不改它当前的显示——人在那个标签上切过的算数。
 */
import type { SurfaceMode } from "./types";

/** 设置值 → 默认显示层：只认 "terminal"，其余（缺省、旧值、乱值）都是聊天 */
export function openSurfaceDefault(setting: string | null | undefined): SurfaceMode {
  return setting === "terminal" ? "terminal" : "chat";
}

/**
 * pendingTerminal 落到标签后，这个标签该切到哪一层；null = 不动它。
 * - 纯 shell / 预填命令（登录、更新、run 脚本）：终端，什么入口都一样
 * - 入口写死了 surface：照写的
 * - 切回已开着的标签：不动
 * - 新开的标签：跟设置
 */
export function launchSurface(input: {
  surface?: SurfaceMode;
  shellOnly?: boolean;
  prefillCommand?: string | null;
  reused: boolean;
  setting: string | null | undefined;
}): SurfaceMode | null {
  if (input.shellOnly || input.prefillCommand) return "terminal";
  if (input.surface) return input.surface;
  if (input.reused) return null;
  return openSurfaceDefault(input.setting);
}
