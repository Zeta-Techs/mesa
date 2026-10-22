/**
 * 聊天层对各家 CLI 能做到哪一步（2026-10-22，tests/chat-fidelity.test.ts；设计 docs/design-chat-fidelity.md）。
 *
 * 聊天层是同一个终端会话的另一种看法，终端才是准的。各家能接近上游到什么程度，取决于聊天层的数据从哪来：
 * CLI 官方的结构化通道最准，其次会话文件，读终端画面最容易随 CLI 改版失效。这里是单一出处：
 * 聊天输入框的「测试版」说明、按版本降级都读它。
 *
 * 已核对到的版本来自 CLI 金丝雀的基线（`scripts/cli-canary/baseline/<平台>/<agent>.json` 的 version，
 * 由 `cli-verified.ts` 在构建时读进来）；本文件只放纯逻辑，版本表由调用方传入。
 */

export type FidelityTier = 1 | 2 | 3 | 4;

export interface ChatFidelity {
  tier: FidelityTier;
  /** 这一家在聊天里的状态、审批、正在写的字从哪来（一句话，给人看） */
  source: string;
  /** 聊天里做不了、要回终端的事 */
  terminalOnly: string;
}

const TIER_LABEL: Record<FidelityTier, string> = {
  1: "接近完整",
  2: "常用的事都能做",
  3: "简化",
  4: "简化版",
};

export function tierLabel(tier: FidelityTier): string {
  return TIER_LABEL[tier];
}

/** 九家逐个写（新增一家时补一行，tests 钉住九家都在） */
export const CHAT_FIDELITY: Record<string, ChatFidelity> = {
  codex: {
    tier: 1,
    source: "回合、审批、思考摘要、正在写的字都来自 Codex 官方通道，审批能直接在聊天里点",
    terminalOnly: "登录、/status 这类只在终端里显示的面板",
  },
  qwen: {
    tier: 1,
    source: "回合、审批、正在写的字都来自 Qwen Code 专为聊天界面提供的通道，审批能直接在聊天里点",
    terminalOnly: "登录、方向键选择的菜单",
  },
  opencode: {
    tier: 1,
    source: "回合、审批、正在写的字都来自 OpenCode 自带的本机服务，审批能直接在聊天里点",
    terminalOnly: "登录、方向键选择的菜单",
  },
  "claude-code": {
    tier: 2,
    source: "回合与审批来自每次启动带上的 hooks；正在写的字、确认菜单、提问表单靠读终端画面",
    terminalOnly: "登录、/cost /usage 这类面板、插件与 MCP 授权",
  },
  grok: {
    tier: 2,
    source: "回合与等确认来自 Grok 自己报的状态；正在写的字和确认菜单靠读终端画面",
    terminalOnly: "登录、方向键选择的菜单",
  },
  gemini: {
    tier: 3,
    source: "没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
  kimi: {
    tier: 3,
    source: "没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
  codebuddy: {
    tier: 3,
    source: "回合与审批来自每次启动带上的 hooks，但正在写的字要等写完一整段才出现",
    terminalOnly: "登录、方向键选择的菜单",
  },
  cursor: {
    tier: 4,
    source: "只有会话文件和终端画面，没有「在等你确认」的信号",
    terminalOnly: "确认菜单、登录、方向键选择的菜单",
  },
};

export function chatFidelity(agentId: string | null | undefined): ChatFidelity | null {
  return (agentId && CHAT_FIDELITY[agentId]) || null;
}

/** 版本串里取 x.y.z（「2.1.306 (Claude Code)」「codex-cli 0.163.0」「grok 1.0.67 (2fe06…)」） */
export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** 平台 → agent → 已核对到的版本（金丝雀基线） */
export type VerifiedTable = Record<string, Record<string, string>>;

/**
 * 这一家已核对到的版本：先取本平台的基线，本平台还没有就取别的平台里最新的（同一版本两边的协议与会话格式一样，
 * 画面略有差别——总比完全没核对强）。都没有返回 null
 */
export function verifiedVersion(table: VerifiedTable, platform: string, agentId: string): string | null {
  const own = table[platform]?.[agentId];
  if (own) return own;
  let best: string | null = null;
  for (const p of Object.keys(table)) {
    const v = table[p]?.[agentId];
    const pv = parseVersion(v);
    if (!v || !pv) continue;
    const pb = parseVersion(best);
    if (!pb || cmp(pv, pb) > 0) best = v;
  }
  return best;
}

export type VersionTrust = "verified" | "newer" | "unknown";

/**
 * 用户装的版本 Mesa 核对过没有：不比核对到的新 = verified；更新 = newer（读屏可能已对不上）；
 * 读不到版本或从没核对过 = unknown（不降级：没有依据说它变了）
 */
export function versionTrust(installed: string | null | undefined, verified: string | null | undefined): VersionTrust {
  const a = parseVersion(installed);
  const b = parseVersion(verified);
  if (!a || !b) return "unknown";
  return cmp(a, b) > 0 ? "newer" : "verified";
}
