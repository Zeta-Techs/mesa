import type { ModelCapabilityDto } from "./types";

/** 上下文窗口写成 200K / 1M；0 或未知不写 */
export function contextLabel(tokens: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** 模型菜单每行右侧的能力灰字：「200K · 思考 · 看图」（能力库 model_capabilities 逐字段查到什么写什么） */
export function modelCapsLabel(c: Pick<ModelCapabilityDto, "context" | "thinking" | "vision">): string {
  return [contextLabel(c.context), c.thinking ? "思考" : null, c.vision ? "看图" : null]
    .filter(Boolean)
    .join(" · ");
}
