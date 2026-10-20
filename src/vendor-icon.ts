/** 端点主机 → 厂商标识（网关库 / 连接行 / 用量页套餐的小图标用）。纯逻辑，素材在 components/VendorIcon.tsx。 */
import type { ProtocolSlots } from "./types.ts";

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
  | "ollama";

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
];

/** 图标是 currentColor 单色：要按文字色渲染（mask），不能当 <img>，否则深色主题里是黑的 */
const MONO: ReadonlySet<VendorId> = new Set(["anthropic", "openai", "kimi", "openrouter", "xai", "ollama"]);

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
  return provider === "zhipu" || provider === "kimi" || provider === "minimax" ? provider : null;
}
