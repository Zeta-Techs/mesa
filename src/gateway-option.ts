import type { Gateway, ProtocolSlots } from "./types.ts";
import { slotForAgent } from "./gateway-slot.ts";

const SLOT_SHORT: { key: keyof ProtocolSlots; label: string }[] = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI" },
  { key: "responses", label: "Responses" },
  { key: "gemini", label: "Gemini" },
  { key: "cursor", label: "Cursor" },
];

/** 端点主机名，给列表/选择器认网关用。 */
export function endpointHost(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return "";
  try {
    return new URL(value).host || "自定义端点";
  } catch {
    const parts = value
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#\s]/)[0]
      .split("@");
    const authority = parts[parts.length - 1];
    return authority && /^[\w.:[\]-]+$/.test(authority)
      ? authority
      : "自定义端点";
  }
}

export function gatewayHosts(slots: ProtocolSlots): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { key } of SLOT_SHORT) {
    const url = slots[key]?.trim();
    if (!url) continue;
    const host = endpointHost(url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

export function gatewayFilledSlots(slots: ProtocolSlots): string[] {
  return SLOT_SHORT.filter(({ key }) => Boolean(slots[key]?.trim())).map(
    (item) => item.label,
  );
}

export type GatewayPickerRow = {
  id: string;
  name: string;
  detail: string;
};

function rowFrom(gateway: Gateway): GatewayPickerRow {
  const hosts = gatewayHosts(gateway.slots);
  const slots = gatewayFilledSlots(gateway.slots);
  const parts: string[] = [];
  parts.push(hosts.length ? hosts.join(" / ") : "未填端点");
  // 协议槽多了一行装不下（网关库里截成「…、Cur…」）：超过 3 种只列前两种 + 总数
  if (slots.length > 3) parts.push(`${slots.slice(0, 2).join("、")} 等 ${slots.length} 种协议`);
  else if (slots.length) parts.push(slots.join("、"));
  const models = gateway.models.filter((model) => model.status !== "stale").length;
  if (models) parts.push(`${models} 个模型`);
  return { id: gateway.id, name: gateway.name, detail: parts.join(" · ") };
}

/** 选用已有网关：名称 + 主机/协议槽/模型数。同名同址才补密钥尾号。 */
export function gatewayPickerRows(gateways: readonly Gateway[]): GatewayPickerRow[] {
  const rows = gateways.map(rowFrom);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.name}\0${row.detail}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.map((row, index) => {
    if ((counts.get(`${row.name}\0${row.detail}`) ?? 0) < 2) return row;
    const hint = gateways[index]?.keyHint?.trim();
    return hint ? { ...row, detail: `${row.detail} · ${hint}` } : row;
  });
}

/** 这家 Agent 能不能接这个网关：它要的协议槽填了没有（qwen / kimi 两种协议都认） */
function gatewayServesAgent(slots: ProtocolSlots, agent: string): boolean {
  const filled = (key: keyof ProtocolSlots) => Boolean(slots[key]?.trim());
  if (agent === "qwen" || agent === "kimi") return filled("openai") || filled("anthropic");
  return filled(slotForAgent(agent, null));
}

/**
 * 「添加连接」弹窗打开时的默认选择（2026-10-20，上手引导）：还没有连接在用的网关多半是刚在
 * 网关库里建的——默认「选用已有网关」并选中最后一个这样的网关；Agent 优先挑已装好、且这个
 * 网关填了它协议槽的那家（有 Claude Code 先选它）。没有这样的网关就照旧「新建网关」。
 */
export function addConnectionDefaults(input: {
  gateways: readonly Pick<Gateway, "id" | "slots">[];
  /** 现有连接各自绑的网关 id（官方账号为空） */
  boundGatewayIds: readonly (string | null | undefined)[];
  /** 已安装的 agent id，按 AGENTS 顺序 */
  installed: readonly string[];
  /** 从某家 agent 组发起时预选的 agent，优先于一切推断 */
  presetAgent?: string | null;
}): { gatewayId: string | null; agent: string } {
  const bound = new Set(input.boundGatewayIds.filter(Boolean));
  const gateway = [...input.gateways].reverse().find((g) => !bound.has(g.id)) ?? null;
  if (input.presetAgent) return { gatewayId: gateway?.id ?? null, agent: input.presetAgent };
  const usable = gateway
    ? input.installed.filter((agent) => gatewayServesAgent(gateway.slots, agent))
    : [...input.installed];
  const pool = usable.length ? usable : input.installed;
  const agent = pool.includes("claude-code") ? "claude-code" : (pool[0] ?? "claude-code");
  return { gatewayId: gateway?.id ?? null, agent };
}
