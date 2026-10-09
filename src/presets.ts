/**
 * 内置端点预设（provider 级）：只收录官方与公开端点。第三方商业中转默认不收录，
 * 用户明确要求的例外收录：confidence 必须标 "address-only"（最低背书档）并在
 * note 注明时效风险——中转站模型随上架/备案变动，一切以「验证并获取」拉到的
 * 目录为准（2026-10-08 ZetaTechs 首例，profiles.md 定位表同步）。
 * 一份预设描述一个供应商在各协议槽的端点与推荐模型——网关本来就是一份多槽对象，
 * 预设跟着网关走：网关库新建表单直接用整表，「添加连接」按 Agent 所需槽位派生
 * （presetsForAgent）。加供应商 = 加一条。
 */
import { AGENT_PROTOCOLS } from "./types.ts";
import { slotForAgent, type GatewaySlotName } from "./gateway-slot.ts";

export interface ProviderPreset {
  /** 显示名，也作网关/连接的默认名 */
  name: string;
  /** 各协议槽端点；未列出的槽不填（该槽的 Agent 看不到这条预设） */
  slots: Partial<Record<GatewaySlotName, string>>;
  /** 适用 Agent；缺省 = 除 gemini/cursor 外全部 */
  agents?: string[];
  /** 个别 Agent 的协议覆盖（如 kimi 对 Moonshot 走官方 kimi 协议） */
  protocolByAgent?: Record<string, string>;
  /** 一键接入推荐模型（精选 ≤3）；「验证并获取」后与实际目录求交，不在目录的不选 */
  models?: string[];
  noAuth?: boolean;
  note?: string;
  /** 某个槽的特别说明（如智谱 Responses 专用端点） */
  slotNotes?: Partial<Record<GatewaySlotName, string>>;
  confidence?: "official" | "verified-compatible" | "address-only";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: "Anthropic 官方",
    agents: ["claude-code"],
    slots: { anthropic: "https://api.anthropic.com" },
    confidence: "official",
  },
  {
    name: "腾讯 CodeBuddy 国际站",
    agents: ["codebuddy"],
    slots: { anthropic: "https://www.codebuddy.ai" },
  },
  {
    name: "腾讯 CodeBuddy 中国站",
    agents: ["codebuddy"],
    slots: { anthropic: "https://copilot.tencent.com" },
  },
  {
    name: "DeepSeek",
    slots: {
      anthropic: "https://api.deepseek.com/anthropic",
      openai: "https://api.deepseek.com/v1",
      responses: "https://api.deepseek.com/v1",
    },
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    slotNotes: {
      anthropic: "Anthropic 兼容端点；Claude 用 ANTHROPIC_AUTH_TOKEN、CodeBuddy 用 CODEBUDDY_API_KEY 鉴权",
    },
    confidence: "official",
  },
  {
    name: "智谱 GLM",
    slots: {
      anthropic: "https://open.bigmodel.cn/api/anthropic",
      openai: "https://open.bigmodel.cn/api/paas/v4",
      responses: "https://open.bigmodel.cn/api/v1",
    },
    models: ["glm-5.3", "glm-5.3-flash"],
    slotNotes: {
      responses: "Codex 专用 Responses 端点；paas/v4 会 404",
      anthropic:
        "Anthropic 兼容端点；Claude 用 ANTHROPIC_AUTH_TOKEN、CodeBuddy 用 CODEBUDDY_API_KEY 鉴权",
    },
    confidence: "official",
  },
  {
    name: "Moonshot 月之暗面",
    slots: {
      openai: "https://api.moonshot.cn/v1",
      responses: "https://api.moonshot.cn/v1",
    },
    protocolByAgent: { kimi: "kimi" },
    models: ["kimi-k3", "kimi-k2.5"],
    confidence: "official",
  },
  {
    name: "阿里云百炼（兼容模式）",
    slots: {
      openai: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      responses: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    models: ["qwen3-coder-plus", "qwen3.7-plus"],
    confidence: "official",
  },
  {
    name: "OpenAI 官方",
    agents: ["codex"],
    slots: {
      responses: "https://api.openai.com/v1",
      openai: "https://api.openai.com/v1",
    },
    models: ["gpt-5.6-sol"],
    confidence: "official",
  },
  {
    name: "OpenRouter",
    slots: {
      openai: "https://openrouter.ai/api/v1",
      responses: "https://openrouter.ai/api/v1",
    },
    note: "聚合多家，模型以实际目录为准",
  },
  {
    name: "xAI 官方",
    agents: ["grok"],
    slots: { openai: "https://api.x.ai/v1" },
    confidence: "official",
  },
  {
    name: "Ollama 本地",
    slots: {
      openai: "http://localhost:11434/v1",
      responses: "http://localhost:11434/v1",
    },
    noAuth: true,
    note: "无需密钥；模型取决于本机已拉取",
  },
  {
    name: "ZetaTechs 中转",
    slots: {
      // anthropic 槽不带 /v1：注入的 ANTHROPIC_BASE_URL 由 Claude Code 自己拼 /v1/messages
      //（同 DeepSeek/智谱先例）；New API 的 Anthropic 协议路由就在根下 /v1/messages。
      // openai/responses 槽按 OpenAI 族约定带 /v1。
      anthropic: "https://api.zetatechs.com",
      openai: "https://api.zetatechs.com/v1",
      responses: "https://api.zetatechs.com/v1",
    },
    models: ["kimi-k3", "deepseek-v4.1-flash", "glm-5.3-flash"],
    note: "New API 中转；2026-07 起下架未备案境外模型（Claude/Gemini/Grok），可用模型以「验证并获取」为准",
    slotNotes: {
      anthropic:
        "端点不带 /v1（Claude Code 自己拼 /v1/messages）；ANTHROPIC_AUTH_TOKEN、CodeBuddy 用 CODEBUDDY_API_KEY 鉴权",
    },
    confidence: "address-only",
  },
];

/** 没有（也不该有）任何预设的 Agent；缺省适用面里排除它们 */
const PRESET_EXEMPT_AGENTS = new Set(["gemini", "cursor"]);

/** 派生视图：沿用旧 per-agent 预设的字段，弹层下拉消费 */
export interface Preset {
  name: string;
  agent: string;
  baseUrl: string;
  note?: string;
  /** 多协议 agent（qwen/kimi）的预设隐含协议，填充时一并写入表单 */
  protocol?: string;
  wireApi?:
    | "chat-completions"
    | "responses"
    | "anthropic-messages"
    | "gemini"
    | "cursor";
  confidence?: "official" | "verified-compatible" | "address-only";
  /** 所属 provider 预设（一键接入需要完整槽位与推荐模型） */
  provider: ProviderPreset;
}

const WIRE_BY_SLOT: Record<GatewaySlotName, NonNullable<Preset["wireApi"]>> = {
  anthropic: "anthropic-messages",
  openai: "chat-completions",
  responses: "responses",
  gemini: "gemini",
  cursor: "cursor",
};

/**
 * 某 Agent 视角的预设列表：按 Agent 协议槽过滤出可用端点。
 * 协议推导——protocolByAgent 优先；qwen/kimi 按 provider 提供的槽反推
 * （有 openai 槽 → openai 协议，只有 anthropic 槽 → anthropic）。
 */
export function presetsForAgent(agent: string): Preset[] {
  const out: Preset[] = [];
  const spec = AGENT_PROTOCOLS[agent];
  for (const provider of PROVIDER_PRESETS) {
    const applies = provider.agents
      ? provider.agents.includes(agent)
      : !PRESET_EXEMPT_AGENTS.has(agent);
    if (!applies) continue;
    let protocol: string | null = provider.protocolByAgent?.[agent] ?? null;
    if (!protocol && spec) {
      if (provider.slots.openai) protocol = "openai";
      else if (provider.slots.anthropic) protocol = "anthropic";
    }
    const slot = slotForAgent(agent, protocol);
    const baseUrl = provider.slots[slot];
    if (!baseUrl) continue;
    out.push({
      name: provider.name,
      agent,
      baseUrl,
      protocol: spec ? (protocol ?? spec.default) : undefined,
      note: provider.slotNotes?.[slot] ?? provider.note,
      wireApi: WIRE_BY_SLOT[slot],
      confidence: provider.confidence,
      provider,
    });
  }
  return out;
}

/**
 * 没有预设的 agent 及其原因（v3.88）。
 * 空下拉看起来像功能坏了——两家「本来就不该有预设」必须说清楚，而不是给个空选择器。
 */
export const NO_PRESET_REASON: Record<string, string> = {
  gemini: "用 Google 官方账号/API 时 Base URL 留空即可，不需要填端点。",
  cursor:
    "Cursor 的端点是它自家协议（非 OpenAI/Anthropic 兼容），第三方供应商端点接上也不通，所以不设预设。",
};
