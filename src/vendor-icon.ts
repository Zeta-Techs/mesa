/** 端点主机 → 厂商标识（网关库 / 连接行 / 用量页套餐的小图标用）。纯逻辑，素材在 components/VendorIcon.tsx。 */
import { walletHostMatches } from "./gateway-balance.ts";
import { endpointHost } from "./gateway-option.ts";
import type { Gateway, ProtocolSlots } from "./types.ts";

export type VendorId =
  | "anthropic"
  | "openai"
  | "deepseek"
  | "zhipu"
  | "kimi"
  | "minimax"
  | "alibaba"
  | "tencent"
  | "openrouter"
  | "xai"
  | "ollama"
  | "newapi"
  | "gemini"
  | "cursor"
  | "doubao";

/** 域名后缀 → 厂商；只认官方域名，商业中转站不在此表（不给第三方运营方做图标位） */
const SUFFIX_RULES: [string, VendorId][] = [
  ["anthropic.com", "anthropic"],
  ["openai.com", "openai"],
  ["deepseek.com", "deepseek"],
  ["bigmodel.cn", "zhipu"],
  ["z.ai", "zhipu"],
  ["moonshot.cn", "kimi"],
  ["moonshot.ai", "kimi"],
  ["kimi.com", "kimi"],
  ["minimax.io", "minimax"],
  ["minimaxi.com", "minimax"],
  ["aliyuncs.com", "alibaba"],
  ["tencent.com", "tencent"],
  ["codebuddy.ai", "tencent"],
  ["openrouter.ai", "openrouter"],
  ["x.ai", "xai"],
  ["generativelanguage.googleapis.com", "gemini"],
  ["cursor.com", "cursor"],
  ["cursor.sh", "cursor"],
];

/** 图标是 currentColor 单色：要按文字色渲染（mask），不能当 <img>，否则深色主题里是黑的 */
const MONO: ReadonlySet<VendorId> = new Set(["anthropic", "openai", "kimi", "openrouter", "xai", "ollama", "cursor"]);

export function isMonoVendor(v: VendorId): boolean {
  return MONO.has(v);
}

const SLOT_ORDER: (keyof ProtocolSlots)[] = ["anthropic", "openai", "responses", "gemini", "cursor"];

function hostnameOf(url: string): { host: string; port: string } | null {
  const value = url.trim();
  if (!value) return null;
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return { host: u.hostname.toLowerCase(), port: u.port };
  } catch {
    return null;
  }
}

export function vendorForUrl(url: string | null | undefined): VendorId | null {
  const h = url ? hostnameOf(url) : null;
  if (!h) return null;
  if ((h.host === "localhost" || h.host === "127.0.0.1") && h.port === "11434") return "ollama";
  for (const [suffix, id] of SUFFIX_RULES) {
    if (h.host === suffix || h.host.endsWith(`.${suffix}`)) return id;
  }
  return null;
}

/**
 * 网关的标识：先认官方厂商域名；认不出时，是 New API 站（槽 URL 命中已知钱包站，或用户给它配了钱包）
 * 就标 New API——它标的是中转站用的平台软件，不是某家中转站的品牌。
 */
export function vendorForGateway(
  g: Pick<Gateway, "slots"> & Partial<Pick<Gateway, "walletUserId" | "walletKeyHint">>,
): VendorId | null {
  const official = vendorForSlots(g.slots);
  if (official) return official;
  const onWalletHost = SLOT_ORDER.some((k) => {
    const u = g.slots[k]?.trim();
    return u ? walletHostMatches(endpointHost(u)) : false;
  });
  return onWalletHost || g.walletUserId || g.walletKeyHint ? "newapi" : null;
}

/** 连接行：这条连接实际用的地址优先，认不出再看它所属网关（New API 站） */
export function vendorForProfile(
  baseUrl: string | null | undefined,
  gateway: Parameters<typeof vendorForGateway>[0] | null | undefined,
): VendorId | null {
  return vendorForUrl(baseUrl) ?? (gateway ? vendorForGateway(gateway) : null);
}

/** 官方账号连接没有端点：按 Agent 认厂商 */
const OFFICIAL_VENDOR: Record<string, VendorId> = {
  "claude-code": "anthropic",
  codex: "openai",
  gemini: "gemini",
  qwen: "alibaba",
  kimi: "kimi",
  codebuddy: "tencent",
  grok: "xai",
  cursor: "cursor",
};

export function vendorForOfficialAgent(agent: string): VendorId | null {
  return OFFICIAL_VENDOR[agent] ?? null;
}

/** 网关：按协议槽顺序取第一个认得出的厂商 */
export function vendorForSlots(slots: ProtocolSlots): VendorId | null {
  for (const key of SLOT_ORDER) {
    const v = vendorForUrl(slots[key]);
    if (v) return v;
  }
  return null;
}

/** 用量页套餐标识（后端给的 provider 键）→ 厂商 */
export function vendorForPlanProvider(provider: string): VendorId | null {
  if (provider === "claude") return "anthropic";
  if (provider === "codex") return "openai";
  return provider === "zhipu" || provider === "kimi" || provider === "minimax" ? provider : null;
}

/** 模型名 → 出这个模型的厂商（出图模型的图标用：2026-10-29 用户「用所选的模型代表的图标」）。
 *  只认模型家族名，不认中转站；认不出（Flux 等没有图标素材的）返回 null，调用方给中性图标 */
const MODEL_RULES: [RegExp, VendorId][] = [
  [/claude|anthropic/, "anthropic"],
  [/gpt|dall-?e|sora|chatgpt|openai|(^|\/)o[134](-|$)/, "openai"],
  [/gemini|imagen|veo|nano-?banana|google/, "gemini"],
  [/grok|aurora|x-?ai\//, "xai"],
  [/cogview|cogvideo|glm|zhipu/, "zhipu"],
  [/wanx|wan2|qwen|tongyi|dashscope|alibaba/, "alibaba"],
  [/hunyuan|tencent/, "tencent"],
  [/kimi|moonshot/, "kimi"],
  [/minimax|hailuo|abab/, "minimax"],
  [/deepseek/, "deepseek"],
  [/doubao|seedream|seededit|seedance|bytedance/, "doubao"],
];

export function vendorForModel(model: string | null | undefined): VendorId | null {
  const m = model?.trim().toLowerCase();
  if (!m) return null;
  for (const [re, id] of MODEL_RULES) if (re.test(m)) return id;
  return null;
}
