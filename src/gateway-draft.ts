import type {
  FetchModelsResultDto,
  GatewayModel,
  GatewayProbeDto,
  ProtocolSlots,
  SlotProbeSummary,
} from "./types";
import {
  agentForSlot,
  firstFilledCatalogSlot,
  PROBEABLE_GATEWAY_SLOTS,
  type GatewaySlotName,
} from "./gateway-slot.ts";

export function effectiveSlotUrl(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  key: GatewaySlotName,
  masterUrl: string,
): string {
  const own = (slots[key] ?? "").trim();
  return own || masterUrl.trim();
}

/** Codex 走 Responses 协议，端点必须实现 /responses。
 * 智谱 /api/paas/v4 只有 chat/completions（带 key 打 /responses 实测 404），
 * Codex 专用端点是 https://open.bigmodel.cn/api/v1（官方 coding-plan 文档），
 * 且该端点不提供 /models 模型目录（200 包错误体）——目录走 paas/v4/models。
 * 只对 open.bigmodel.cn 的 paas/v4 路径报警，避免误伤其他网关。 */
export function responsesSlotUrlWarning(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname !== "open.bigmodel.cn") return null;
  if (!parsed.pathname.includes("/paas/v4")) return null;
  return "智谱 paas/v4 只有 chat/completions，Codex 打 /responses 会 404。正确填法：Base URL 保持 paas/v4 端点（「获取模型」走它拉目录），展开「协议槽」把 Responses 单独填 https://open.bigmodel.cn/api/v1（该端点不出模型目录）";
}

/** 智谱 OpenAI 兼容端点按计费方式分两个地址：/api/paas/v4 按量扣账户余额，
 * /api/coding/paas/v4 才抵扣 Coding Plan 套餐。套餐 key 填了按量端点，Grok / Qwen /
 * OpenCode 等走 OpenAI 协议的 Agent 一发请求就报 1113「余额不足或无可用资源包」，
 * 而 Claude（/api/anthropic）、Codex（/api/v1）照常能用——极易误诊成 Agent 的问题。
 * 两个端点 /models 都能拉，「测试」「获取模型」看不出差别，只能在地址上提示。 */
export function zhipuOpenAiSlotBillingHint(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (host !== "open.bigmodel.cn" && host !== "api.z.ai") return null;
  if (!parsed.pathname.startsWith("/api/paas/v4")) return null;
  const coding = `${parsed.origin}/api/coding/paas/v4`;
  return `智谱 /api/paas/v4 是按量计费端点，从账户余额扣费，不抵扣 Coding Plan 套餐。买的是套餐就把 OpenAI 槽改成 ${coding}——否则 Grok、Qwen 等走 OpenAI 协议的 Agent 会报「余额不足或无可用资源包」，而 Claude、Codex 照常能用`;
}

/** 五个槽都空、或都等于主输入（含主输入同步进槽的同址情况）。 */
export function slotsFollowMaster(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
): boolean {
  const keys: GatewaySlotName[] = [
    "anthropic",
    "openai",
    "responses",
    "gemini",
    "cursor",
  ];
  const filled = keys
    .map((key) => (slots[key] ?? "").trim())
    .filter(Boolean);
  if (filled.length === 0) return true;
  const master = masterUrl.trim();
  const expected = master || filled[0];
  return filled.every((url) => url === expected);
}

export function firstProbeableSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
): GatewaySlotName | null {
  return (
    PROBEABLE_GATEWAY_SLOTS.find((key) =>
      Boolean(effectiveSlotUrl(slots, key, masterUrl)),
    ) ?? null
  );
}

export function catalogSlotWalkOrder(prefer?: string | null): GatewaySlotName[] {
  const order: GatewaySlotName[] = ["anthropic", "openai", "responses", "gemini"];
  if (prefer && order.includes(prefer as GatewaySlotName)) {
    const first = prefer as GatewaySlotName;
    return [first, ...order.filter((slot) => slot !== first)];
  }
  return order;
}

export function catalogFetchSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
  prefer?: string | null,
): GatewaySlotName | null {
  const filled: Partial<Record<GatewaySlotName, string>> = {};
  for (const key of catalogSlotWalkOrder(prefer)) {
    const url = effectiveSlotUrl(slots, key, masterUrl);
    if (url) filled[key] = url;
  }
  return firstFilledCatalogSlot(filled, prefer);
}

/** 测试主按钮：优先上次拉目录成功的槽，避免同址时误打 Anthropic /messages。 */
export function primaryProbeSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
  prefer?: string | null,
): GatewaySlotName | null {
  const catalog = catalogFetchSlot(slots, masterUrl, prefer);
  if (catalog && PROBEABLE_GATEWAY_SLOTS.includes(catalog)) return catalog;
  return firstProbeableSlot(slots, masterUrl);
}

export function parseHeaderEnv(text: string): Record<string, string> {
  const headerEnv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    headerEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headerEnv;
}

export function fetchedIdsToModels(
  ids: string[],
  fetchedAt: string,
  catalogSlot?: string | null,
): GatewayModel[] {
  return ids.map((id) => ({
    id,
    source: "fetched",
    status: "available",
    lastSeenAt: fetchedAt,
    catalogSlot: catalogSlot ?? null,
    temperature: null,
    topP: null,
    maxOutputTokens: null,
    reasoningEffort: null,
  }));
}

export function probeDtoToSummary(
  slot: string,
  dto: GatewayProbeDto,
): SlotProbeSummary {
  const basic = dto.checks.find((check) => check.message.startsWith("基础请求"));
  return {
    slot,
    lastOk: dto.ok,
    lastLatencyMs:
      basic?.latencyMs != null ? Number(basic.latencyMs) : null,
    lastProbeAt: new Date().toISOString(),
  };
}

export function fetchModelsInvokeArgs(input: {
  baseUrl: string;
  apiKey: string;
  noAuth: boolean;
  slot: GatewaySlotName;
  gatewayId?: string | null;
}): {
  baseUrl: string;
  apiKey: string | null;
  agentId: string;
  gatewayId: string | null;
  force: boolean;
} {
  return {
    baseUrl: input.baseUrl,
    apiKey: input.noAuth || !input.apiKey.trim() ? null : input.apiKey.trim(),
    agentId: agentForSlot(input.slot),
    gatewayId: input.gatewayId ?? null,
    force: true,
  };
}

export function applyFetchedCatalog(
  local: GatewayModel[],
  result: FetchModelsResultDto,
  slot: GatewaySlotName,
  merge: (local: GatewayModel[], incoming: GatewayModel[]) => GatewayModel[],
): GatewayModel[] {
  return merge(
    local,
    fetchedIdsToModels(result.models, result.fetchedAt, slot),
  );
}

/** 网关 /models 没带 OpenRouter 风格能力字段时的可见说明。 */
export function catalogCapabilityNote(
  modelCount: number,
  capabilityCount: number,
): string | null {
  if (modelCount <= 0) return null;
  if (capabilityCount > 0) {
    return `其中 ${capabilityCount} 个带网关能力字段（上下文/视觉/推理）`;
  }
  return "网关只返回模型 ID，没有上下文/视觉/推理。能力声明用连接页 ⋯「下载模型能力库」。";
}

export function catalogFetchNotice(
  modelCount: number,
  capabilityCount: number,
  slot?: string | null,
): string {
  const where = slot ? `（${slot}）` : "";
  const cap = catalogCapabilityNote(modelCount, capabilityCount);
  const head = `已获取 ${modelCount} 个模型${where}`;
  return cap ? `${head}。${cap}` : `${head}。`;
}
