import type { Gateway, ProtocolSlots } from "./types.ts";

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
