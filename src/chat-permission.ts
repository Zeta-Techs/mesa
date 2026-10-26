/**
 * 聊天输入框权限菜单的纯逻辑（docs/design-chat-composer-mockup.html ③④，2026-10-22 用户选定）：
 * - 拿一件具体的事说明四档：示例按项目类型取（编程「跑 npm test」、科研「改 manuscript/draft.md」、
 *   办公「改 周报.docx」、随手聊「新建一个文件」），每档写这件事它会怎么做——比四段抽象说明好懂
 * - ⇧Tab 在输入框里按 先出方案 → 请求批准 → 帮我批准 → 完全访问 轮换（跳过这家没有的档），
 *   和 Claude Code 终端里的手感一致；只在开聊前生效（开聊后换档要重开）
 * - 第一档（2026-10-26 由「只讨论」改名「先出方案」；id 仍是 discuss）分两种说法：Claude Code / CodeBuddy / Gemini / Kimi / Qwen / OpenCode
 *   是各家的计划模式，写完方案会问
 *   「要不要开工」、点头后在同一段对话里接着做（聊天层方案卡，plan-approval.ts，假网关逐家实测）——这一档写「方案你点头了再…」；
 *   Codex / Grok 这一档是只读沙箱，Cursor 没法在假网关下核实，照旧写「不…，告诉你怎么…」
 */
import type { StarterContext } from "./chat-empty-start.ts";

export type PermissionTierId = "discuss" | "ask" | "auto" | "full";

export const PERMISSION_ORDER: readonly PermissionTierId[] = ["discuss", "ask", "auto", "full"];

export interface PermissionExample {
  /** 「假如它要」后面的动词 */
  verb: string;
  /** 动作对象：命令或文件名，等宽显示 */
  target: string;
  outcomes: Record<PermissionTierId, string>;
}

/** 先出方案 = 计划模式、写完方案能在同一段对话里点头开工的家（本机假网关实测过方案确认那一屏的） */
export const PLAN_FIRST_AGENTS: ReadonlySet<string> = new Set(["claude-code", "codebuddy", "gemini", "kimi", "qwen", "opencode"]);

function example(verb: string, target: string, discuss: string, planFirst: boolean): PermissionExample {
  return {
    verb,
    target,
    outcomes: {
      discuss: planFirst ? `方案你点头了再${verb}` : discuss,
      ask: "先停下来问你",
      auto: `直接${verb}；删文件这类才问`,
      full: `直接${verb}，删文件也不问`,
    },
  };
}

export function permissionExample(context: StarterContext, agentId?: string | null): PermissionExample {
  const planFirst = Boolean(agentId && PLAN_FIRST_AGENTS.has(agentId));
  switch (context) {
    case "coding":
      return example("跑", "npm test", "不跑，告诉你怎么跑", planFirst);
    case "research":
      return example("改", "manuscript/draft.md", "不改，说给你听怎么改", planFirst);
    case "office":
      return example("改", "周报.docx", "不改，说给你听怎么改", planFirst);
    default:
      return example("建", "一个新文件", "不建，告诉你怎么做", planFirst);
  }
}

/** ⇧Tab：下一档（跳过不可用的）；current 不知道时从第一档可用的开始；一档都不可用返回 null */
export function nextPermissionTier(
  current: PermissionTierId | null,
  available: (id: PermissionTierId) => boolean,
): PermissionTierId | null {
  const start = current ? PERMISSION_ORDER.indexOf(current) : -1;
  for (let step = 1; step <= PERMISSION_ORDER.length; step++) {
    const id = PERMISSION_ORDER[(start + step + PERMISSION_ORDER.length) % PERMISSION_ORDER.length];
    if (id !== current && available(id)) return id;
  }
  return null;
}
