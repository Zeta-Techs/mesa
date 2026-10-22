//! 聊天输入框斜杠命令面板的纯逻辑（tests/slash-commands.test.ts）。
//! 命令表是**保守常用集**：matrix 只源码级实证过 /model、/effort（claude/kimi）、
//! /model set（gemini）等少数命令，各家 TUI 没有全量斜杠命令调研；
//! 表内命令写错的代价只是 CLI 回一句「未知命令」，不破坏会话。选错/缺失都往这里补。

export interface SlashCommand {
  /** 含前导 / */
  cmd: string;
  /** 中文一句话说明 */
  hint: string;
}

const HELP: SlashCommand = { cmd: "/help", hint: "查看 CLI 内置命令" };

const TABLE: Record<string, SlashCommand[]> = {
  claude: [
    { cmd: "/model", hint: "切换模型" },
    { cmd: "/effort", hint: "切换思考档位" },
    { cmd: "/compact", hint: "压缩上下文" },
    { cmd: "/clear", hint: "清空会话重新开始" },
    { cmd: "/init", hint: "生成项目说明文件" },
    { cmd: "/review", hint: "让 Agent 评审改动" },
    HELP,
  ],
  codex: [
    { cmd: "/model", hint: "切换模型" },
    { cmd: "/compact", hint: "压缩上下文" },
    { cmd: "/diff", hint: "查看当前改动" },
    { cmd: "/status", hint: "查看会话状态" },
    { cmd: "/plan", hint: "先出计划再动手" },
    { cmd: "/review", hint: "让 Agent 评审改动" },
    { cmd: "/new", hint: "开始新会话" },
    HELP,
  ],
  kimi: [
    { cmd: "/model", hint: "切换模型（吃别名）" },
    { cmd: "/effort", hint: "切换思考档位" },
    // Kimi Code 2.3 实证：单数 /permission，弹三档选择器，聊天层出卡片选
    { cmd: "/permission", hint: "切换权限模式" },
    HELP,
  ],
  gemini: [
    { cmd: "/model", hint: "切换模型" },
    { cmd: "/clear", hint: "清空会话重新开始" },
    HELP,
  ],
  qwen: [
    { cmd: "/model", hint: "切换模型" },
    // 0.22.0 bundle 实证 /effort 直切命令（effortCommand；0.21.1 无）
    { cmd: "/effort", hint: "切换思考档位（0.22+）" },
    { cmd: "/clear", hint: "清空会话重新开始" },
    HELP,
  ],
  opencode: [
    { cmd: "/models", hint: "打开模型选择器（在露出的终端里用方向键完成）" },
    HELP,
  ],
  codebuddy: [
    { cmd: "/login", hint: "登录官方账号（会打开浏览器）" },
    HELP,
  ],
  // cursor / grok 的斜杠命令未做源码级全量调研，只给 /help，写错的代价是 CLI 回「未知命令」
  cursor: [HELP],
  grok: [HELP],
};

// Claude Code 的 agent id 是 claude-code：表里原只登记了 claude，Claude Code 用户的斜杠面板只剩 /help（2026-10-17 发现）
TABLE["claude-code"] = TABLE.claude!;

/** 该 agent 的斜杠命令清单；未收录的 agent 只给 /help 兜底 */
export function slashCommandsFor(
  agentId: string | null | undefined,
): SlashCommand[] {
  return (agentId && TABLE[agentId]) || [HELP];
}

/** 按前缀过滤（query 不含前导 /），保持表内顺序 */
export function filterSlashCommands(
  list: SlashCommand[],
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  return list.filter((c) => c.cmd.slice(1).toLowerCase().startsWith(q));
}

/** 输入框内容是否处于「斜杠命令输入中」：/ 开头、无空格无换行（有空格=进入参数阶段，面板收起） */
export function slashQueryOf(value: string): string | null {
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n"))
    return null;
  return value.slice(1);
}
