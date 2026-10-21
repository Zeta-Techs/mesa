/** Agent → 网关协议槽（与 gateway_store::slot_for_agent 双端镜像，tests/gateway-slot.test.ts）。 */

export type GatewaySlotName =
  | "anthropic"
  | "openai"
  | "responses"
  | "gemini"
  | "cursor";

export function slotForAgent(
  agent: string,
  protocol?: string | null,
): GatewaySlotName {
  // codebuddy 走 OpenAI chat/completions（同 gateway_store.rs slot_for_agent）
  if (agent === "claude-code") return "anthropic";
  if (agent === "codex") return "responses";
  if (agent === "gemini") return "gemini";
  if (agent === "cursor") return "cursor";
  if ((agent === "qwen" || agent === "kimi") && protocol === "anthropic") {
    return "anthropic";
  }
  return "openai";
}

export function firstFilledCatalogSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>>,
  prefer?: string | null,
): GatewaySlotName | null {
  const order: GatewaySlotName[] = [
    "anthropic",
    "openai",
    "responses",
    "gemini",
  ];
  const filled = (name: GatewaySlotName) => Boolean(slots[name]?.trim());
  if (prefer && order.includes(prefer as GatewaySlotName) && filled(prefer as GatewaySlotName)) {
    return prefer as GatewaySlotName;
  }
  return order.find(filled) ?? null;
}

/** 与 gateway_store::agent_for_slot 双端镜像：探针 /models 用的 Agent。 */
export function agentForSlot(slot: GatewaySlotName): string {
  if (slot === "anthropic") return "claude-code";
  if (slot === "openai") return "opencode";
  if (slot === "responses") return "codex";
  if (slot === "gemini") return "gemini";
  return "cursor";
}

/** 支持通用网关体检的槽（Cursor / Gemini 没有通用探针）。 */
export const PROBEABLE_GATEWAY_SLOTS: GatewaySlotName[] = [
  "anthropic",
  "openai",
  "responses",
];
