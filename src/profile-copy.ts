/**
 * 「复制到其他 agent」（#14）的目标清单纯逻辑（与 DOM 解耦，node --test 直接单测）。
 * 协议族口径与后端 profile_validation::api_kind_label 保持一致（后端 copy_profile_to_agent
 * 会再校验一次，这里只做菜单的禁用与提示）。
 */

// 运行时要取 AGENTS/AGENT_PROTOCOLS 的值，带 .ts 后缀（node --test 直接跑 TS，类型擦除不兜底运行时导入）
import { AGENTS, AGENT_PROTOCOLS } from "./types.ts";

/** 协议族：cursor 是专有协议（非 OpenAI/Anthropic 兼容），自成一族不与任何 agent 互通 */
export function apiKindOf(agent: string, protocol: string | null): string {
  if (agent === "claude-code") return "anthropic";
  if (agent === "gemini") return "gemini";
  if (agent === "cursor") return "cursor";
  if ((agent === "qwen" || agent === "kimi") && protocol === "anthropic")
    return "anthropic";
  return "openai";
}

const KIND_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容",
  gemini: "Gemini",
  cursor: "Cursor 专有",
};

export interface CopyTarget {
  id: string;
  label: string;
  compatible: boolean;
  /** 不兼容时的说明（菜单项 title） */
  reason?: string;
}

/** 复制目标清单：排除来源 agent 自身；不同协议族的项标禁用并给原因 */
export function copyTargets(
  sourceAgent: string,
  sourceProtocol: string | null,
): CopyTarget[] {
  const kind = apiKindOf(sourceAgent, sourceProtocol);
  return AGENTS.filter((a) => a.id !== sourceAgent).map((a) => {
    const spec = AGENT_PROTOCOLS[a.id];
    const compatible = spec
      ? spec.options.some((p) => apiKindOf(a.id, p) === kind)
      : apiKindOf(a.id, null) === kind;
    return {
      id: a.id,
      label: a.label,
      compatible,
      reason: compatible
        ? undefined
        : `协议不兼容：${a.label} 不支持 ${KIND_LABEL[kind] ?? kind} 协议`,
    };
  });
}
