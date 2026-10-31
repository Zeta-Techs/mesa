// 添加连接 / 网关库共用的表单纯逻辑（2026-10-31 网关库与添加连接优化）：失败下一步提示、网关能不能给这家 Agent 用、
// 保存前还缺什么。界面只调这里，口径两处一致。
import type { ProtocolSlots } from "./types.ts";
import { slotForAgent, type GatewaySlotName } from "./gateway-slot.ts";

/** 协议槽在界面上的叫法（网关库槽位标题同一套） */
export const SLOT_LABEL: Record<GatewaySlotName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容",
  responses: "Responses（Codex）",
  gemini: "Gemini",
  cursor: "Cursor",
};

/** 请求失败时补一句下一步：401/403 多是密钥，404 多是地址或模型名，5xx / 400 多是这个模型在服务商那边没有可用线路 */
export function probeHint(message: string): string {
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (!status) return "";
  if (status === "401" || status === "403") return "。检查密钥是否填对、是否属于这家服务商。";
  if (status === "404") return "。检查地址和模型名是否和服务商文档一致。";
  if (status.startsWith("5") || status === "400") return "。可能是这个模型在服务商那边用不了，换一个模型再试。";
  return "";
}

/** 这个网关能不能给这家 Agent 用：填了它要的协议槽（Qwen / Kimi 两种协议任一即可）。
 *  不能用时返回缺的槽名（给界面写「缺 Anthropic 地址」），能用返回 null */
export function gatewayMissingSlot(slots: ProtocolSlots, agent: string): string | null {
  const filled = (key: keyof ProtocolSlots) => Boolean(slots[key]?.trim());
  if (agent === "qwen" || agent === "kimi") {
    return filled("openai") || filled("anthropic") ? null : `${SLOT_LABEL.openai}或 ${SLOT_LABEL.anthropic}`;
  }
  const slot = slotForAgent(agent, null);
  return filled(slot) ? null : SLOT_LABEL[slot];
}

/** 保存前还缺的第一样东西（按表单从上到下的顺序）；什么都不缺返回 null。写在保存钮旁，不只放在悬停里 */
export function saveBlocker(input: {
  accountType: "api" | "official";
  /** 选用已有网关 */
  usesExisting: boolean;
  gatewayPicked: boolean;
  /** 新建网关（含编辑态不显示网关字段时为 false） */
  newGateway: boolean;
  baseUrl: string;
  name: string;
}): string | null {
  if (input.accountType === "api") {
    if (input.usesExisting && !input.gatewayPicked) return "先选一个网关";
    if (input.newGateway && !input.baseUrl.trim()) return "先填地址";
  }
  if (!input.name.trim()) return "先给这条连接起个名字";
  return null;
}

/** 网关库列表行的状态点（2026-10-31）：缺密钥 > 上次测试失败 > 测试通过 > 未测。只读已存的体检结果，不发请求 */
export function gatewayHealth(g: {
  noAuth: boolean;
  keyHint?: string | null;
  slotProbes?: readonly { lastOk: boolean | null }[];
}): { tone: "ok" | "err" | "warn" | "idle"; label: string } {
  if (!g.noAuth && !g.keyHint) return { tone: "warn", label: "缺密钥" };
  const probes = (g.slotProbes ?? []).filter((p) => p.lastOk != null);
  if (probes.some((p) => p.lastOk === false)) return { tone: "err", label: "测试失败" };
  if (probes.length > 0) return { tone: "ok", label: "测试通过" };
  return { tone: "idle", label: "未测" };
}

/** 这个模型在网关上设过参数（思考档 / 温度 / top_p / 输出上限）：列表行上标「已设置」、可筛 */
export function modelHasPolicy(m: {
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
}): boolean {
  return m.temperature != null || m.topP != null || m.maxOutputTokens != null || m.reasoningEffort != null;
}

/** 手填进网关目录的模型名：去空白；空、已在目录里的返回错误文案 */
export function manualModelError(raw: string, existing: readonly string[]): string | null {
  const id = raw.trim();
  if (!id) return "填模型名";
  if (/\s/.test(id)) return "模型名里不能有空格";
  if (existing.includes(id)) return "目录里已经有这个模型";
  return null;
}
