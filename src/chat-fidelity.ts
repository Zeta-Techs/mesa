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
  /**
   * 还标不标「测试版」。摘掉的条件（docs/design-chat-fidelity.md §4）：连续两周金丝雀全绿，且日常等确认在聊天卡上都能接住。
   * 达标把这一家改成 false 即可。第三、四档本来就承诺不了完整，不叫测试版，固定写「简化」
   */
  beta: boolean;
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
    beta: true,
    source: "回合、审批、思考摘要、正在写的字都来自 Codex 官方通道，审批能直接在聊天里点",
    terminalOnly: "登录、/status 这类终端面板",
  },
  qwen: {
    tier: 1,
    beta: true,
    source: "回合、审批、正在写的字都来自 Qwen Code 专为聊天界面提供的通道，审批能直接在聊天里点",
    terminalOnly: "登录、方向键选择的菜单",
  },
  opencode: {
    tier: 1,
    beta: true,
    source: "回合、审批、正在写的字都来自 OpenCode 自带的本机服务，审批能直接在聊天里点",
    terminalOnly: "登录、方向键选择的菜单",
  },
  "claude-code": {
    tier: 2,
    beta: true,
    source: "回合与审批来自每次启动带上的 hooks；正在写的字、确认菜单、提问表单靠读终端画面",
    terminalOnly: "登录、/cost /usage 这类面板、插件与 MCP 授权",
  },
  grok: {
    tier: 2,
    beta: true,
    source: "回合与等确认来自 Grok 自己报的状态；正在写的字和确认菜单靠读终端画面",
    terminalOnly: "登录、方向键选择的菜单",
  },
  gemini: {
    tier: 3,
    beta: false,
    source: "没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
  // 2026-11-04 起：Kimi 2.4 自己报程序状态（OSC 7501），从读画面推断升到第二档；更老的 Kimi 没有这条旁路，照旧读画面
  kimi: {
    tier: 2,
    beta: true,
    source: "回合与等确认来自 Kimi 自己报的状态（2.4 起；更老的版本靠读终端画面推断）；正在写的字和确认菜单靠读终端画面",
    terminalOnly: "登录、方向键选择的菜单",
  },
  codebuddy: {
    tier: 3,
    beta: false,
    source: "回合与审批来自每次启动带上的 hooks，但正在写的字要等写完一整段才出现",
    terminalOnly: "登录、方向键选择的菜单",
  },
  cursor: {
    tier: 4,
    beta: false,
    source: "只有会话文件和终端画面，没有「在等你确认」的信号",
    terminalOnly: "确认菜单、登录、方向键选择的菜单",
  },
  agy: {
    tier: 2,
    beta: true,
    source: "回合与等确认来自 Antigravity CLI 自己报的状态（开了精确注意力时加读 hooks）；正在写的字和确认菜单靠读终端画面",
    terminalOnly: "登录、方向键选择的菜单",
  },
};

/**
 * Windows 上与上表不同的家：ConPTY 两个方向都吞 OSC，Grok / Kimi / Antigravity CLI 自己报的状态（OSC 7501）到不了 Mesa，
 * 后端 Windows 不接这条旁路（chat_channel.rs prepare），退回和 Gemini 一样读画面（2026-10-25 本机实测）
 */
const CHAT_FIDELITY_WINDOWS: Record<string, ChatFidelity> = {
  kimi: {
    tier: 3,
    beta: false,
    source: "Windows 的终端层会吞掉 Kimi 自己报的状态；没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
  grok: {
    tier: 3,
    beta: false,
    source: "Windows 的终端层会吞掉 Grok 自己报的状态；没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
  agy: {
    tier: 3,
    beta: false,
    source: "Windows 的终端层会吞掉 Antigravity CLI 自己报的状态；没开「精确注意力标记」时，在干活还是在等你都靠读终端画面推断",
    terminalOnly: "登录、方向键选择的菜单、认不出的确认",
  },
};

export function chatFidelity(agentId: string | null | undefined, isWindows = false): ChatFidelity | null {
  if (!agentId) return null;
  return (isWindows && CHAT_FIDELITY_WINDOWS[agentId]) || CHAT_FIDELITY[agentId] || null;
}

/**
 * 输入框左下那个小标签写什么：还在测试的「测试版」；第三、四档「简化」；第一、二档摘了测试版就不标——
 * 但 CLI 比核对过的新时仍要标出来（「未核对」），点开能看到提醒。null = 不显示
 */
export function fidelityBadge(f: ChatFidelity | null, newer: boolean): string | null {
  if (!f) return newer ? "未核对" : null;
  if (f.beta) return "测试版";
  if (f.tier >= 3) return "简化";
  return newer ? "未核对" : null;
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

/** 两个版本串取较新的；一边读不出就取另一边 */
export function newerVersion(a: string | null, b: string | null): string | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) return pb ? b : a;
  if (!pb) return a;
  return cmp(pb, pa) > 0 ? b : a;
}

/**
 * 这家 CLI 该比哪份金丝雀基线：OpenCode 2.x 另有一份「opencode2」（1.x / 2.x 同命令名、不能并存，按装的大版本取，
 * 不然装 2.x 的人永远比 1.x 的核对版本新、一直「未核对」）。后端 cli_verified.rs 联网前移用同一个名字
 */
export function baselineKey(agentId: string, installed: string | null | undefined): string {
  const v = parseVersion(installed);
  return agentId === "opencode" && v && v[0] >= 2 ? "opencode2" : agentId;
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

/**
 * 能开「原生模式」的家（2026-11-26 拍板，docs/design-chat-native-mode.md）：聊天经这家官方接口发消息、停止、答审批，
 * 不往终端里打字、不读屏；十家全部点亮，按连接资格由 nativeModeAllowed 闸门控制，默认关
 */
const NATIVE_MODE_AGENTS = new Set([
  "codex",
  "kimi",
  "claude-code",
  "qwen",
  "opencode",
  "agy",
  "gemini",
  "codebuddy",
  "grok",
  "cursor",
]);

export function nativeModeAvailable(agentId: string | null | undefined): boolean {
  return !!agentId && NATIVE_MODE_AGENTS.has(agentId);
}

/**
 * 原生模式下没有终端界面的家（纯协议运行时：PTY 里起的是 stdio 桥，CLI 跑 ACP / 双向 stream-json）：
 * 发话、斜杠命令都只能经通道；切换模式要在空闲时停下进程、按会话接回。Codex / Qwen / OpenCode 能双客户端，不在这里
 */
const NATIVE_RUNTIME_AGENTS = new Set(["kimi", "claude-code", "agy", "gemini", "codebuddy", "grok", "cursor"]);

export function nativeRuntime(agentId: string | null | undefined): boolean {
  return !!agentId && NATIVE_RUNTIME_AGENTS.has(agentId);
}

/**
 * 原生模式下「停止」也经通道（不往终端里按 Esc）的家。Qwen 的命令文件只有发话与确认回复两种命令，停止仍按 Esc
 */
const NATIVE_STOP_AGENTS = new Set([
  "codex",
  "kimi",
  "claude-code",
  "opencode",
  "agy",
  "gemini",
  "codebuddy",
  "grok",
  "cursor",
]);

export function nativeStopViaChannel(agentId: string | null | undefined): boolean {
  return !!agentId && NATIVE_STOP_AGENTS.has(agentId);
}

/** 原生模式下没有终端界面的家，说明页换成这两句（数据来源是官方协议，终端独有的面板用不了） */
const NATIVE_RUNTIME_NOTES: Record<string, Pick<ChatFidelity, "source" | "terminalOnly">> = {
  kimi: {
    source: "原生模式：回合、审批、正在写的字都来自 Kimi Code 的官方协议，确认和停止都在聊天里完成",
    terminalOnly: "登录这类终端面板",
  },
  "claude-code": {
    source: "原生模式：回合、审批、提问表单、计划确认、正在写的字都来自 Claude Code 的官方协议，都在聊天里完成",
    terminalOnly: "登录、/status 这类终端面板",
  },
  agy: {
    source: "原生模式（仅官方登录账号）：回合、审批、正在写的字都来自 Antigravity CLI 官方 ACP 协议，确认和停止都在聊天里完成",
    terminalOnly: "登录、「帮我批准」档位",
  },
  gemini: {
    source: "原生模式：回合、审批、正在写的字都来自 Gemini CLI 官方 ACP 协议，确认和停止都在聊天里完成",
    terminalOnly: "登录这类终端面板",
  },
  codebuddy: {
    source: "原生模式：回合、审批、正在写的字都来自 CodeBuddy 官方 ACP 协议，确认和停止都在聊天里完成",
    terminalOnly: "登录这类终端面板",
  },
  grok: {
    source: "原生模式：回合、审批、正在写的字都来自 Grok Build 官方 ACP 协议，确认和停止都在聊天里完成",
    terminalOnly: "登录这类终端面板",
  },
  cursor: {
    source: "原生模式：回合、审批、正在写的字都来自 Cursor CLI 官方 ACP 协议，确认和停止都在聊天里完成",
    terminalOnly: "登录这类终端面板",
  },
};

export function nativeFidelityNote(agentId: string | null | undefined): Pick<ChatFidelity, "source" | "terminalOnly"> | null {
  return (agentId && NATIVE_RUNTIME_NOTES[agentId]) || null;
}

/**
 * 这条连接能不能开原生模式：
 * - Claude Code：只对 API 密钥 / 中转网关连接开放（Anthropic 不允许第三方产品提供 claude.ai 订阅登录，设计稿 §1）
 * - Antigravity（agy）：只对官方 Google 登录开放（上游 ACP 暂不认第三方自定义模型，设计稿 §3.3）
 * 后端 pty.rs 同样再挡一道
 */
export function nativeModeAllowed(agentId: string | null | undefined, accountType: string | null | undefined): boolean {
  if (!nativeModeAvailable(agentId)) return false;
  if (agentId === "claude-code" && accountType === "official") return false;
  if (agentId === "agy" && accountType !== "official") return false;
  return true;
}
