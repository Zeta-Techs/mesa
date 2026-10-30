// 能力声明覆盖表单纯逻辑（连接页网关库「能力声明」编辑）：
// 表单字符串 → 覆盖字段（DTO），校验口径与 Rust validate_override 一致。
// 三态：thinking/vision 用 "" 表示未声明（查询链继续向下），"true"/"false" 显式声明。
// 注意：output/api_backend 不进表单——output 的用户旋钮是策略字段 max output
// （能力事实层的 output 只喂 opencode limit.output，已有兜底），UI 保存时透传保留。

export type TriState = "" | "true" | "false";

export interface CapsOverrideFormState {
  context: string;
  thinking: TriState;
  vision: TriState;
}

/** 覆盖条目的可编辑字段（output/api_backend 由调用方往返保留，不进表单） */
export interface CapsOverrideFields {
  thinking: boolean | null;
  context: number | null;
  vision: boolean | null;
}

export const EMPTY_CAPS_FORM: CapsOverrideFormState = {
  context: "",
  thinking: "",
  vision: "",
};

/** 表单 → 覆盖字段；非法输入（非正整数）返回错误文案，与后端校验同口径 */
export function parseCapsOverrideForm(
  state: CapsOverrideFormState,
): { ok: true; fields: CapsOverrideFields } | { ok: false; error: string } {
  const v = state.context.trim();
  if (!v) {
    return {
      ok: true,
      fields: {
        thinking: state.thinking === "" ? null : state.thinking === "true",
        context: null,
        vision: state.vision === "" ? null : state.vision === "true",
      },
    };
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: "上下文窗口必须为正整数" };
  }
  return {
    ok: true,
    fields: {
      thinking: state.thinking === "" ? null : state.thinking === "true",
      context: n,
      vision: state.vision === "" ? null : state.vision === "true",
    },
  };
}

/** 覆盖条目 → 表单初值（未声明的字段留空） */
export function capsFormFromOverride(entry: {
  thinking?: boolean | null;
  context?: number | null;
  vision?: boolean | null;
}): CapsOverrideFormState {
  return {
    context: entry.context != null ? String(entry.context) : "",
    thinking: entry.thinking == null ? "" : entry.thinking ? "true" : "false",
    vision: entry.vision == null ? "" : entry.vision ? "true" : "false",
  };
}

/** 全空表单＝没有声明：保存按钮降级为清除 */
export function capsFormIsEmpty(state: CapsOverrideFormState): boolean {
  return !state.context.trim() && state.thinking === "" && state.vision === "";
}

/** 「声明支持 1M」（连接弹层 Claude 映射表，2026-10-30）：能力库确知 ≥1M 的锁着打勾；用户覆盖层声明的可取消 */
export const ONE_M_TOKENS = 1_000_000;

export function oneMState(
  resolvedContext: number | null | undefined,
  override: { context?: number | null } | undefined,
): { checked: boolean; locked: boolean } {
  const fromOverride = (override?.context ?? 0) >= ONE_M_TOKENS;
  const resolved = (resolvedContext ?? 0) >= ONE_M_TOKENS;
  return { checked: resolved || fromOverride, locked: resolved && !fromOverride };
}

/** 勾 / 取消「1M」后要写的覆盖条目：只动 context，别的字段原样带着；全空返回 null（= 清除这条覆盖） */
export function oneMOverrideEntry(
  model: string,
  on: boolean,
  existing: { thinking?: boolean | null; vision?: boolean | null; output?: number | null; api_backend?: string | null } | undefined,
): { prefix: string; thinking: boolean | null; context: number | null; vision: boolean | null; output: number | null; api_backend: string | null } | null {
  const entry = {
    prefix: model,
    thinking: existing?.thinking ?? null,
    context: on ? ONE_M_TOKENS : null,
    vision: existing?.vision ?? null,
    output: existing?.output ?? null,
    api_backend: existing?.api_backend ?? null,
  };
  const empty = entry.thinking == null && entry.context == null && entry.vision == null && entry.output == null && entry.api_backend == null;
  return empty ? null : entry;
}
