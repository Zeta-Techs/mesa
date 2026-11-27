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
  /** 目标标签正跑在纯协议原生模式（没有终端交互界面，只有桥日志）：「去终端回答」类入口改落聊天页点审批卡 */
  nativeRuntime?: boolean;
}): SurfaceMode | null {
  if (input.shellOnly || input.prefillCommand) return "terminal";
  if (input.nativeRuntime && input.surface === "terminal") return "chat";
  if (input.surface) return input.surface;
  if (input.reused) return null;
  return openSurfaceDefault(input.setting);
}

export interface TopBarModeInput {
  surface: SurfaceMode;
  /** 纯 shell（登录/脚本/更新）或自定义运行时：无聊天模式 */
  terminalOnly: boolean;
  /** 运行中实态：后端实报 nativeRuntime 或通道是 acp / claude-native */
  actualNativeRuntime: boolean;
  /** 标签计划以纯协议原生方式运行（尚未起进程时预判） */
  plannedNativeRuntime: boolean;
  /** 双客户端原生（Codex / Qwen / OpenCode）：后台终端与结构化通道并存，切换不重启 */
  dualClientNative: boolean;
  /** 当前存在活跃 PTY（可拉取 pty_native_log） */
  hasPty: boolean;
}

export interface TopBarModeSpec {
  /** 顶栏原 >_ 位置：logs = 纯协议原生运行日志抽屉，terminal = 兼容模式终端入口，none = 不显示 */
  primaryButton: "logs" | "terminal" | "none";
  /** ⋯ 菜单里的单次模式切换项；null = 纯 shell / 自定义运行时不给 */
  menuSwitch: {
    label: "改用终端模式打开" | "改用聊天模式打开";
    targetSurface: SurfaceMode;
    /** true = 需停进程按会话接回（或起新进程）切换 nativeMode；false = 同进程当场切换 */
    switchNative: boolean;
  } | null;
  /** 侧边提问（/btw）仅在聊天模式显示 */
  showAsideButton: boolean;
}

/**
 * 顶栏右上角三路分流（2026-11-27 单一工作界面预设）：
 * 按「当前这段对话实际怎么跑」决定，不在界面层写死十家矩阵：
 * - 纯协议原生聊天 → 右上角换成「运行日志」抽屉，⋯ 放「改用终端模式打开」（空闲重启接回）
 * - 双客户端原生聊天（Codex / Qwen / OpenCode）→ 不显示 >_，⋯ 放「改用终端模式打开」（同进程当场切）
 * - 兼容模式聊天（Claude 官方订阅 / agy 网关 / ACP 分叉或自动回落）→ 保留 >_ 终端入口，⋯ 同左
 * - 终端模式 → 去掉「回聊天」与侧边提问钮，⋯ 放「改用聊天模式打开」
 */
export function topBarModeSpec(input: TopBarModeInput): TopBarModeSpec {
  if (input.terminalOnly) {
    return { primaryButton: "none", menuSwitch: null, showAsideButton: false };
  }
  if (input.surface !== "chat") {
    return {
      primaryButton: "none",
      menuSwitch: {
        label: "改用聊天模式打开",
        targetSurface: "chat",
        switchNative: true,
      },
      showAsideButton: false,
    };
  }
  if (input.actualNativeRuntime || input.plannedNativeRuntime) {
    return {
      primaryButton: input.hasPty || input.actualNativeRuntime ? "logs" : "none",
      menuSwitch: {
        label: "改用终端模式打开",
        targetSurface: "terminal",
        switchNative: true,
      },
      showAsideButton: true,
    };
  }
  if (input.dualClientNative) {
    return {
      primaryButton: "none",
      menuSwitch: {
        label: "改用终端模式打开",
        targetSurface: "terminal",
        switchNative: false,
      },
      showAsideButton: true,
    };
  }
  return {
    primaryButton: "terminal",
    menuSwitch: {
      label: "改用终端模式打开",
      targetSurface: "terminal",
      switchNative: false,
    },
    showAsideButton: true,
  };
}

/** 剥除协议桥日志中可能夹带的 ANSI CSI/OSC 控制序列，保留可读纯文本 */
export function stripAnsiLog(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
