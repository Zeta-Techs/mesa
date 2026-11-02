import type { ModelCapabilityDto } from "./types";

/** 上下文窗口写成 200K / 1M；0 或未知不写 */
export function contextLabel(tokens: number | null | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    // 取一位小数、去掉尾随 .0：1,048,576（2^20）写 1M，和同菜单里的 1,000,000 一个写法（2026-11-02 菜单里 1.0M / 1M 并排）
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

/** 模型菜单每行右侧的能力灰字：「200K · 思考 · 看图」（能力库 model_capabilities 逐字段查到什么写什么） */
export function modelCapsLabel(c: Pick<ModelCapabilityDto, "context" | "thinking" | "vision">): string {
  return [contextLabel(c.context), c.thinking ? "思考" : null, c.vision ? "看图" : null]
    .filter(Boolean)
    .join(" · ");
}
