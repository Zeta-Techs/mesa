/**
 * 网关库「一键配置各 CLI」的纯逻辑（2026-11-04 用户拍板，tests/gateway-autoconfig.test.ts）：
 * 给每个已安装的 CLI 在这个网关上各建一条连接，模型取目录里各家最新的。
 *
 * - 「最新」只按型号里的版本号比（claude-opus-4-7 > 4-6、kimi-k3 > k2.5），同版本旗舰档优先；不看跑分、
 *   不评哪家更好——Mesa 不做模型研判（AGENTS.md「少占注意力」）。
 * - 目录里只认出一家（智谱、Kimi 一类厂商网关）：每个 CLI 都配这家。认出多家（聚合网关）：
 *   原厂 CLI 配原厂模型（Claude Code → Claude、Codex → GPT …），目录里没有这家的就不配、写明原因，不拿别家顶。
 * - OpenCode / CodeBuddy 没有原厂模型：名单放各家最新旗舰，默认用哪个不预选，由人在预览里选。
 * - 每条连接 = 这家最新一代的整套产品线（2026-11-04 用户：「最简单就是各家官方的推荐模型，Claude 那四款最新的」）：
 *   同一大版本里每条产品线取最新一款（Claude opus / sonnet / fable / haiku，GPT-6 sol / terra / astra / luna），
 *   旗舰排第一作默认；同代的轻量款作后台小模型（Claude 的 haiku 也指向它），上一代的轻量款不配（grok-3-mini）。
 */
import { modelKind } from "./model-kinds.ts";
import { slotForAgent, type GatewaySlotName } from "./gateway-slot.ts";
import { SLOT_LABEL } from "./connection-form.ts";
import type { ProviderPreset } from "./presets.ts";
import type { Gateway, GatewayModel, Profile, RoleModels } from "./types.ts";

export type VendorId =
  | "claude"
  | "gpt"
  | "gemini"
  | "grok"
  | "glm"
  | "kimi"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "doubao";

export const VENDOR_LABEL: Record<VendorId, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  grok: "Grok",
  glm: "GLM",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  doubao: "豆包",
};

// 先匹配的先赢：deepseek 排在 qwen 前（deepseek-r1-distill-qwen 归 DeepSeek）
const VENDOR_RULES: [VendorId, RegExp][] = [
  ["claude", /claude|^(opus|sonnet|haiku)\b/],
  ["deepseek", /deepseek/],
  ["gpt", /^(gpt|chatgpt|codex|o\d)/],
  ["gemini", /gemini/],
  ["grok", /grok/],
  ["glm", /glm/],
  ["kimi", /kimi|moonshot/],
  ["qwen", /qwen|qwq/],
  ["minimax", /minimax|abab/],
  ["doubao", /doubao/],
];

/** 各 CLI 的原厂模型；不在表里的（OpenCode / CodeBuddy）走多厂商名单，Cursor 单独处理 */
const HOME_VENDOR: Record<string, VendorId> = {
  "claude-code": "claude",
  codex: "gpt",
  gemini: "gemini",
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
};
const MULTI_VENDOR_AGENTS = new Set(["opencode", "codebuddy"]);
/** 有「后台小模型」分工的 CLI（与 role-models.ts ROLES 同） */
const SMALL_ROLE_AGENTS = new Set(["claude-code", "grok", "opencode"]);

const LIGHT_TOKENS = new Set(["mini", "nano", "flash", "lite", "haiku", "air", "small", "fast", "instant", "tiny", "micro"]);
const TOP_TOKENS = new Set(["opus", "pro", "max", "ultra", "plus"]);
// 不是拿来写代码对话的变体：一律不选
const SPECIAL_TOKENS = new Set([
  "search", "audio", "realtime", "tts", "transcribe", "research", "computer", "image", "vision", "vl",
  "ocr", "translate", "embedding", "embed", "rerank", "moderation", "math",
]);
// 同版本里往后放的：思考 / 预览 / 实验 / 快速通道一类别名
const VARIANT_TOKENS = new Set(["thinking", "preview", "exp", "experimental", "beta", "turbo", "free", "online", "latest"]);
// 不单算一条产品线的：上面的别名，加中转自己拼的开关后缀（-reasoning / -non-reasoning / -openai-compact …）
const NOT_A_LINE_TOKENS = new Set([
  ...VARIANT_TOKENS, "instruct", "reasoning", "non", "nothinking", "multi", "agent", "customtools", "compact", "openai", "chat",
]);
/** 一条连接最多放几款（Claude Code 选择器上限 5） */
const LINEUP_MAX = 5;

function bareId(id: string): string {
  const lower = id.trim().toLowerCase();
  return (lower.split("/").pop() ?? lower).replace(/^\[[^\]]*\]\s*/, "");
}

function tokensOf(id: string): string[] {
  return bareId(id).split(/[^a-z0-9]+/).filter(Boolean);
}

/** 型号属于哪家（认不出返回 null） */
export function modelVendor(id: string): VendorId | null {
  const bare = bareId(id);
  if (!bare) return null;
  for (const [vendor, re] of VENDOR_RULES) if (re.test(bare)) return vendor;
  return null;
}

/**
 * 型号里的版本号（各段原样字符串）：取第一段「1–3 位数字 + 若干 .x / -x 小版本」。
 * 不算的：日期（2025-09-11、20260101、0309 这类 4 位以上或跟在年份后的月日）、上下文长度与参数量（32k、72b）。
 * claude-opus-4-7-20260101 → 4,7；qwen-plus-2025-09-11 → 无；doubao-pro-32k-241215 → 无；grok-4.20-0309 → 4,20
 */
function versionParts(id: string): string[] {
  const bare = bareId(id).replace(/(^|[-_])\d{4}(?:[-_]\d{2}){1,2}(?=$|[-_])/g, "$1");
  const re = /(?<!\d)(\d{1,3})(?!\d)(?![kmb](?![a-z]))((?:[.-]\d{1,2}(?![\da-z]))*)/g;
  for (const m of bare.matchAll(re)) {
    return [m[1], ...(m[2] ? m[2].slice(1).split(/[.-]/) : [])];
  }
  return [];
}

/** 版本号的数字形式（展示、测试用） */
export function modelVersion(id: string): number[] {
  return versionParts(id).map(Number);
}

/**
 * 比两个型号的版本：大版本按整数比，小版本按小数位比（grok-4.20 是 4.2，旧于 4.7——xAI 的 4.20 早于 4.3～4.7）。
 * 返回正数 = a 更新。
 */
export function compareModelVersion(a: string, b: string): number {
  const va = versionParts(a);
  const vb = versionParts(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = va[i] ?? "0";
    const y = vb[i] ?? "0";
    const d = i === 0 ? Number(x) - Number(y) : Number(`0.${x}`) - Number(`0.${y}`);
    if (d) return d;
  }
  // 有版本号的新于没有的（kimi-k3 > kimi-for-coding 之外的老别名）
  return va.length - vb.length;
}

export function isLightModel(id: string): boolean {
  return tokensOf(id).some((t) => LIGHT_TOKENS.has(t));
}

function usable(m: GatewayModel): boolean {
  if (!m.id.trim() || m.status === "stale") return false;
  if (modelKind(m.id) !== "chat") return false;
  return !tokensOf(m.id).some((t) => SPECIAL_TOKENS.has(t));
}

function tierScore(id: string, vendor: VendorId | null): number {
  const toks = tokensOf(id);
  // GPT 的 -pro 是又慢又贵的长考型号，不当日常旗舰
  if (vendor === "gpt" && toks.includes("pro")) return 0;
  return toks.some((t) => TOP_TOKENS.has(t)) ? 2 : 1;
}

function variantPenalty(id: string): number {
  return tokensOf(id).filter((t) => VARIANT_TOKENS.has(t)).length;
}

/** 同一家里从新到旧排：版本号 > 旗舰档 > 少带变体后缀 > 名字短（别名优先于带日期的快照） */
function newestFirst(ids: string[], vendor: VendorId | null): string[] {
  return [...ids].sort(
    (a, b) =>
      compareModelVersion(b, a) ||
      tierScore(b, vendor) - tierScore(a, vendor) ||
      variantPenalty(a) - variantPenalty(b) ||
      a.length - b.length ||
      a.localeCompare(b),
  );
}

export interface VendorPicks {
  /** 旗舰候选，最新的在前（预览下拉用） */
  flagships: string[];
  /** 和旗舰同一代的最新轻量型号；没有为 null */
  light: string | null;
  /** 最新一代每条产品线的最新一款：旗舰第一、其余旗舰档、轻量档最后，最多 LINEUP_MAX 款 */
  lineup: string[];
}

/** 产品线：去掉带数字的段（版本、日期、规格）。claude-opus-5-5 → claude-opus、gpt-6.1-sol → gpt-sol、qwen3.8-max → max */
export function modelLine(id: string): string {
  return tokensOf(id).filter((t) => !/\d/.test(t)).join("-");
}

function isLineModel(id: string): boolean {
  return modelLine(id) !== "" && !tokensOf(id).some((t) => NOT_A_LINE_TOKENS.has(t));
}

/** 模型输入单价（美元 / 百万 token，后端 model_input_prices 给，与用量页算费同一条定价链）；查不到的不在表里 */
export type PriceTable = Readonly<Record<string, number>>;

/**
 * 目录里某一家的最新旗舰、同代轻量与整套产品线。
 * 轻量先看名字（mini / flash / haiku …），名字看不出的再看价格——GPT-6 按代号分档
 * （astra / sol / terra / luna），luna 单价只有 sol 的 1/20，名字里却没有 mini（2026-11-04 用户 Zeta 网关实例）：
 * - 旗舰：按新旧挑，同一大版本里有贵 8 倍以上的兄弟就当它是轻量档跳过（sol 对 astra 只差 5 倍，不跳）；
 * - 轻量：和旗舰同一大版本、名字像轻量或单价不到旗舰 1/5 的，取最新；上一代的不要（用户：grok-3-mini 不是最新就不配）。
 * 价格不全时退回只看名字。只有轻量型号的厂商：轻量的当旗舰。
 */
export function vendorPicks(catalog: readonly GatewayModel[], vendor: VendorId, prices: PriceTable = {}): VendorPicks {
  const ids = catalog.filter((m) => usable(m) && modelVendor(m.id) === vendor).map((m) => m.id);
  let named = newestFirst(ids.filter((id) => isLightModel(id)), vendor);
  let heavy = newestFirst(ids.filter((id) => !isLightModel(id)), vendor);
  if (heavy.length === 0) [heavy, named] = [named, []];
  if (heavy.length === 0) return { flagships: [], light: null, lineup: [] };
  const major = (id: string) => modelVersion(id)[0] ?? -1;
  const price = (id: string) => prices[id];
  const dwarfed = (id: string) => {
    const p = price(id);
    return p != null && heavy.some((o) => o !== id && major(o) === major(id) && (price(o) ?? 0) >= p * 8);
  };
  const flagship = heavy.find((id) => !dwarfed(id)) ?? heavy[0];
  const fp = price(flagship);
  // 只认和旗舰同一代的：上一代的老模型便宜是因为旧（kimi-k2-thinking 对 kimi-k3），也不是「最新」
  const sameGen = (id: string) => major(id) === major(flagship);
  const cheap = (id: string) => id !== flagship && fp != null && price(id) != null && price(id)! * 5 <= fp;
  const lights = newestFirst([...named, ...heavy.filter(cheap)].filter(sameGen), vendor);
  const tops = heavy.filter((id) => id !== flagship && !cheap(id));
  // 每条产品线先在整条线里挑最新的一款（带日期的快照让给不带的），再排：旗舰档在前、轻量档在后
  const best = new Map<string, string>();
  for (const id of newestFirst([...tops, ...lights].filter((id) => sameGen(id) && isLineModel(id)), vendor)) {
    if (!best.has(modelLine(id))) best.set(modelLine(id), id);
  }
  best.delete(modelLine(flagship));
  const members = [...best.values()];
  const lineup = [
    flagship,
    ...tops.filter((id) => members.includes(id)),
    ...lights.filter((id) => members.includes(id)),
  ];

  const light = lights.find((id) => lineup.includes(id)) ?? lights[0] ?? null;
  if (light && !lineup.includes(light)) lineup.push(light);
  // 超出上限时先保住旗舰和轻量
  const capped = lineup.length > LINEUP_MAX ? [...lineup.filter((id) => id !== light).slice(0, LINEUP_MAX - 1), light!] : lineup;
  return { flagships: [flagship, ...tops], light, lineup: capped };
}

/** 目录里认得出的厂商，按在目录里第一次出现的顺序（不排名次） */
export function catalogVendors(catalog: readonly GatewayModel[]): VendorId[] {
  const seen: VendorId[] = [];
  for (const m of catalog) {
    if (!usable(m)) continue;
    const v = modelVendor(m.id);
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

function normUrl(u: string | null | undefined): string {
  return (u ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

/** 网关地址对上哪条内置预设（只用它的 protocolByAgent，如 Kimi 走官方 kimi 协议） */
export function matchPreset(gateway: Pick<Gateway, "slots">, presets: readonly ProviderPreset[]): ProviderPreset | null {
  const mine = Object.values(gateway.slots ?? {}).map(normUrl).filter(Boolean);
  return presets.find((p) => Object.values(p.slots).some((u) => u && mine.includes(normUrl(u)))) ?? null;
}

export interface AutoConfigRow {
  agent: string;
  protocol: string | null;
  slot: GatewaySlotName | null;
  /** 默认模型的候选（预览下拉）；多厂商行是各家最新旗舰 */
  options: string[];
  /** 预选的默认模型；多厂商行为 null，必须人选 */
  defaultModel: string | null;
  /** 多厂商行：每个候选是哪家（选中后补同家轻量用） */
  vendorOf: Record<string, VendorId>;
  /** 每家同代的轻量型号 */
  lightOf: Partial<Record<VendorId, string>>;
  /** 每家最新一代的整套产品线 */
  lineupOf: Partial<Record<VendorId, string[]>>;
  /** 多厂商行（OpenCode / CodeBuddy 在聚合网关上）：名单放各家旗舰 */
  multi: boolean;
  /** 不配的原因；null = 可以配 */
  skip: string | null;
  /** 已有一条一模一样的连接（后端会拒绝重复建） */
  duplicateOf: string | null;
}

function pickProtocol(agent: string, gateway: Pick<Gateway, "slots">, preset: ProviderPreset | null): string | null {
  if (agent !== "qwen" && agent !== "kimi") return null;
  const filled = (p: string) => Boolean(gateway.slots?.[slotForAgent(agent, p)]?.trim());
  const fromPreset = preset?.protocolByAgent?.[agent];
  if (fromPreset && filled(fromPreset)) return fromPreset;
  // 第三方端点 OpenAI 兼容最稳（同 preset-flow extraBindTargets）
  if (filled("openai")) return "openai";
  if (filled("anthropic")) return "anthropic";
  return "openai";
}

/** 预览表：每个已安装的 CLI 一行（按传入顺序） */
export function planAutoConfig(input: {
  gateway: Pick<Gateway, "id" | "slots" | "models">;
  installed: readonly string[];
  profiles: readonly ProfileLike[];
  presets: readonly ProviderPreset[];
  /** 目录模型的输入单价；没给就只按名字认轻量 */
  prices?: PriceTable;
}): AutoConfigRow[] {
  const { gateway, installed, profiles } = input;
  const preset = matchPreset(gateway, input.presets);
  const vendors = catalogVendors(gateway.models);
  const single = vendors.length === 1 ? vendors[0] : null;
  const picks = new Map(vendors.map((v) => [v, vendorPicks(gateway.models, v, input.prices)]));
  const lightOf: Partial<Record<VendorId, string>> = {};
  const lineupOf: Partial<Record<VendorId, string[]>> = {};
  for (const [v, p] of picks) {
    if (p.light) lightOf[v] = p.light;
    lineupOf[v] = p.lineup;
  }

  return installed.map((agent): AutoConfigRow => {
    const protocol = pickProtocol(agent, gateway, preset);
    const base: AutoConfigRow = {
      agent,
      protocol,
      slot: null,
      options: [],
      defaultModel: null,
      vendorOf: {},
      lightOf,
      lineupOf,
      multi: false,
      skip: null,
      duplicateOf: null,
    };
    if (agent === "cursor") return { ...base, skip: "Cursor 只用自家账号的模型，接不了第三方网关" };
    const slot = slotForAgent(agent, protocol);
    if (!gateway.slots?.[slot]?.trim()) {
      return { ...base, slot, skip: `网关没填 ${SLOT_LABEL[slot]} 协议地址` };
    }
    if (vendors.length === 0) return { ...base, slot, skip: "目录里认不出是哪家的模型，请用「添加连接」手动选" };

    let row: AutoConfigRow;
    if (single || !MULTI_VENDOR_AGENTS.has(agent)) {
      const vendor = single ?? HOME_VENDOR[agent];
      const p = vendor ? picks.get(vendor) : undefined;
      if (!vendor || !p || p.flagships.length === 0) {
        const label = vendor ? VENDOR_LABEL[vendor] : "原厂";
        return { ...base, slot, skip: `目录里没有 ${label} 模型` };
      }
      const vendorOf = Object.fromEntries(p.flagships.map((id) => [id, vendor]));
      row = { ...base, slot, options: p.flagships, defaultModel: p.flagships[0], vendorOf };
    } else {
      const options: string[] = [];
      const vendorOf: Record<string, VendorId> = {};
      for (const v of vendors) {
        const top = picks.get(v)?.flagships[0];
        if (top) {
          options.push(top);
          vendorOf[top] = v;
        }
      }
      row = { ...base, slot, options, defaultModel: options.length === 1 ? options[0] : null, vendorOf, multi: true };
    }
    if (row.defaultModel) row.duplicateOf = duplicateConnection(row, rowModels(row, row.defaultModel), gateway.id, profiles);
    return row;
  });
}

type ProfileLike = Pick<Profile, "agent" | "gatewayId" | "protocol" | "models" | "extraEnv" | "name">;

/** 这个网关上已有一条名单一模一样的同家连接：返回它的名字（后端 has_duplicate_binding 会拒绝重复建）。models = 人在预览里定下的名单 */
export function duplicateConnection(
  row: AutoConfigRow,
  models: readonly string[],
  gatewayId: string,
  profiles: readonly ProfileLike[],
): string | null {
  const dup = profiles.find(
    (p) =>
      p.agent === row.agent &&
      p.gatewayId === gatewayId &&
      (p.protocol ?? null) === row.protocol &&
      Object.keys(p.extraEnv ?? {}).length === 0 &&
      p.models.length === models.length &&
      p.models.every((m, i) => m === models[i]),
  );
  return dup ? dup.name : null;
}

/** 选定默认模型后的名单：多厂商行 = 选中的放第一 + 其余各家旗舰 + 选中那家的同代轻量；其余行 = 选中的放第一 + 这家最新一代整套产品线 */
export function rowModels(row: AutoConfigRow, chosen: string): string[] {
  const vendor = row.vendorOf[chosen] ?? modelVendor(chosen);
  if (!row.multi) {
    const lineup = (vendor ? row.lineupOf[vendor] : undefined) ?? [];
    return [chosen, ...lineup.filter((m) => m !== chosen)].slice(0, LINEUP_MAX);
  }
  const light = vendor ? row.lightOf[vendor] : undefined;
  const list = [chosen, ...row.options.filter((m) => m !== chosen)];
  if (light && !list.includes(light)) list.push(light);
  return list;
}

/**
 * 模型分工：同代轻量的作后台小模型。Claude Code 写显式映射：名单里名字带 sonnet / opus / fable 的各占对应别名，
 * 没有的跟默认（智谱这类非 Claude 模型就全跟默认）；haiku 跟后台小模型
 */
export function rowRoleModels(row: AutoConfigRow, chosen: string): RoleModels {
  return roleModelsFor(row, rowModels(row, chosen));
}

/**
 * 按人改过的名单（第一个 = 默认）定分工：后台小模型先认默认那家的同代轻量，名单里没有就取第一个名字像轻量的；
 * Claude Code 别名同 rowRoleModels
 */
export function roleModelsFor(row: AutoConfigRow, models: readonly string[]): RoleModels {
  const chosen = models[0] ?? "";
  const vendor = row.vendorOf[chosen] ?? modelVendor(chosen);
  const light = vendor ? row.lightOf[vendor] : undefined;
  const rest = models.slice(1);
  const pickLight = light && rest.includes(light) ? light : rest.find((id) => isLightModel(id)) ?? null;
  const small = pickLight && SMALL_ROLE_AGENTS.has(row.agent) ? pickLight : null;
  const roles: RoleModels = { small, subagent: null };
  if (row.agent === "claude-code") {
    const slots: Record<string, string> = {};
    for (const alias of ["sonnet", "opus", "fable"]) {
      const m = models.find((id) => tokensOf(id).includes(alias));
      if (m) slots[alias] = m;
    }
    roles.slots = slots;
  }
  return roles;
}

/**
 * 预览里某个模型槽可换成的模型：目录里能对话的，和这个槽同家的排前面（新的在前），其余按目录顺序。
 * 名单里已有的（除了这个槽自己）不列
 */
export function slotCandidates(
  catalog: readonly GatewayModel[],
  current: string | null,
  taken: readonly string[],
): string[] {
  const ids = catalog.filter(usable).map((m) => m.id).filter((id) => id === current || !taken.includes(id));
  const vendor = current ? modelVendor(current) : null;
  if (!vendor) return ids;
  const same = newestFirst(ids.filter((id) => modelVendor(id) === vendor), vendor);
  return [...same, ...ids.filter((id) => modelVendor(id) !== vendor)];
}
