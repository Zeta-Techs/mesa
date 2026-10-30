/**
 * 思考强度的「深度」（docs/design-chat-composer-mockup.html ②，2026-10-22）：Mesa 图标里的 M，中间那道 V
 * 随档位加深——low 几乎是平的，最高档就是图标原样；「默认」不知道 CLI 自己用哪档，画灰 M 不装作知道。
 * 滑块旁、模型芯片里用同一个小 M（EffortMark），档名照 CLI 原名不翻译。滑块下原有一句白话说这一档意味着什么，
 * 2026-10-30 用户嫌多余删掉（保持画面干净）。
 */

/** 明说不思考的档名：深度 0 */
const NO_THINK = new Set(["off", "none", "disabled", "minimal"]);

/**
 * 当前档的深度 0..1：value 在 levels（不含「默认」）里的位置，最后一档为 1；
 * 空串 / 认不出 = null（默认档，不知道深浅）
 */
export function effortDepth(value: string | null | undefined, levels: readonly string[]): number | null {
  const v = value?.trim() ?? "";
  if (!v) return null;
  if (NO_THINK.has(v.toLowerCase())) return 0;
  const scale = levels.filter((l) => l && !NO_THINK.has(l.toLowerCase()));
  const i = scale.indexOf(v);
  if (i < 0) return null;
  return (i + 1) / scale.length;
}

/** M 中间那道 V 的谷底 y（16×14 的画布里，顶 2、底 13）：深度 0 → 2.5，1 → 12 */
export function effortValleyY(depth: number): number {
  const d = Math.min(1, Math.max(0, depth));
  return Math.round((2.5 + d * 9.5) * 10) / 10;
}
