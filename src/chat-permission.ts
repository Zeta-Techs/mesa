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
import { isNewChatKey } from "./quick-chat.ts";
import { readerReuseKey } from "./reader.ts";

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

// ===== 按连接记住完全访问（2026-11-13 用户拍板）=====
// 聊天里亲手给某条连接选了完全访问：之后用这条连接开的对话默认就是完全访问；在这条连接上换回别的档就忘掉。
// 换了连接 / 换了 Agent，标签带着的完全访问不跟过去（新那条也记过的除外）。只管聊天对话：
// 步骤、阅读、商量这类入口各有自己的权限口径；重启后恢复出的标签不带（safety.md「本机原生权限档」）。

const FULL_ACCESS_KEY = "ccode.chatFullAccess";

function loadFullAccess(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FULL_ACCESS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 这条连接记过完全访问 */
export function rememberedFullAccess(profileId: string | null | undefined): boolean {
  return Boolean(profileId) && loadFullAccess().includes(profileId!);
}

/** 人在聊天里亲手换档后调：完全访问记下，先出方案 / 请求批准 / 帮我批准忘掉；mode = null（回到本机设置，多是换家时自动回落）不动 */
export function rememberChatPermission(
  profileId: string | null | undefined,
  permission: "discuss" | "write_tree",
  mode: "ask" | "auto" | "full" | null | undefined,
): void {
  if (!profileId || (permission === "write_tree" && !mode)) return;
  const full = permission === "write_tree" && mode === "full";
  const list = loadFullAccess().filter((id) => id !== profileId);
  if (full) list.push(profileId);
  try {
    localStorage.setItem(FULL_ACCESS_KEY, JSON.stringify(list));
  } catch {
    /* 记不下就每次再选 */
  }
}

/** 这个标签算不算聊天对话（按复用键）：空白新对话、侧栏接着聊、没带键的新标签 */
export function chatPermissionMemoryApplies(reuseKey: string | null | undefined): boolean {
  return !reuseKey || isNewChatKey(reuseKey) || reuseKey.startsWith("resume:");
}

/** 侧栏 / 对话页「接着聊」派发时的复用键：
 *  - 原 Run 已记下非聊天复用键（`ws:` / `reader:` / `discuss:` / `lane:` / `task:` 等）：原样沿用，
 *    既能与步骤卡 / 阅读区的标签互认，也不会把聊天连接的完全访问带进步骤或精读；
 *  - 沉浸阅读区的精读对话（`s.reader`）：按项目 / PDF 拼 `reader:` 键（pty_spawn 靠它预放行 notes/）；
 *  - 流程 / 工作区对话（`s.stepName` / `s.stepRole` / `s.workspace`）：`step-resume:<agent>:<sid>`；
 *  - 普通聊天：`resume:<agent>:<sid>`。 */
export function resumeSessionReuseKey(
  s: {
    agent: string;
    sessionId: string;
    projectPath: string;
    reader?: boolean;
    readerPdf?: string | null;
    stepName?: string | null;
    stepRole?: string | null;
    workspace?: string | null;
  },
  runReuseKey?: string | null,
): string {
  const rk = runReuseKey?.trim() || "";
  if (rk && !chatPermissionMemoryApplies(rk)) return rk;
  if (s.reader) {
    return s.readerPdf ? readerReuseKey(s.projectPath, s.readerPdf) : `reader:${s.projectPath}`;
  }
  if (s.stepName || s.stepRole || s.workspace) {
    return `step-resume:${s.agent}:${s.sessionId}`;
  }
  return `resume:${s.agent}:${s.sessionId}`;
}

/** 连接定了 / 换了之后标签的原生档该改成什么；undefined = 不动。
 *  记过的连接：按本机设置时改成完全访问，人选过别的档不动；没记过：带着的完全访问回到本机设置 */
export function profilePermissionMode(input: {
  permission: "discuss" | "write_tree";
  mode: "ask" | "auto" | "full" | null;
  remembered: boolean;
  /** 这家有完全访问的启动参数（Agent 名单没读到时为 false：只是先不改成完全访问，不会因此忘掉） */
  fullAvailable: boolean;
}): "full" | null | undefined {
  if (input.permission === "discuss") return undefined;
  if (input.remembered) return input.mode === null && input.fullAvailable ? "full" : undefined;
  return input.mode === "full" ? null : undefined;
}
