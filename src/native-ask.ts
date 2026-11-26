/**
 * 原生模式 Claude 的提问表单（docs/design-chat-native-mode.md 第 3 期，tests/native-ask.test.ts）。
 *
 * 终端模式下提问表单是读屏认出来的（tui-ask.ts），答一题要按键；原生模式下 AskUserQuestion 经 can_use_tool 直接把题目
 * 结构给过来（ApprovalDto.questions），答案经通道一次交回（updatedInput.answers = {题目: 答案}）。这里把题目 + 已选的
 * 画成和终端模式同一种表单（ClaudeAsk，ChatDecisionCard 照画），并把表单上的操作（AskAction）落成新的已选或最终答案。
 * 交法同终端：只有一道单选题时选了就交；多题或多选题选完到确认页再交。多选的答案按选中顺序用「, 」连起来。
 */
import type { AskAction, AskRow, ClaudeAsk } from "./tui-ask";

export interface NativeQuestion {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
}

export interface NativeAskState {
  /** 当前在第几题；等于题数 = 确认页 */
  current: number;
  /** 每题选中的选项文字 */
  picks: string[][];
  /** 每题自己写的答案 */
  free: (string | null)[];
}

export type NativeAskResult = { kind: "submit"; answers: Record<string, string> } | { kind: "cancel" } | null;

/** ApprovalDto.questions（AskUserQuestion 的 questions 原样）→ 题目表；认不出的题跳过 */
export function parseNativeQuestions(raw: unknown): NativeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeQuestion[] = [];
  for (const q of raw.slice(0, 20)) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== "string" || !r.question.trim()) continue;
    const options = Array.isArray(r.options)
      ? r.options
          .slice(0, 20)
          .map((o) => {
            if (typeof o === "string") return { label: o, description: null };
            const x = (o ?? {}) as Record<string, unknown>;
            return typeof x.label === "string"
              ? { label: x.label, description: typeof x.description === "string" ? x.description : null }
              : null;
          })
          .filter((o): o is { label: string; description: string | null } => o !== null)
      : [];
    out.push({
      question: r.question,
      header: typeof r.header === "string" && r.header.trim() ? r.header : null,
      multiSelect: r.multiSelect === true,
      options,
    });
  }
  return out;
}

export function initialNativeAsk(qs: NativeQuestion[]): NativeAskState {
  return { current: 0, picks: qs.map(() => []), free: qs.map(() => null) };
}

function answerOf(st: NativeAskState, i: number): string {
  const parts = [...(st.picks[i] ?? [])];
  const free = st.free[i]?.trim();
  if (free) parts.push(free);
  return parts.join(", ");
}

function answered(st: NativeAskState, i: number): boolean {
  return answerOf(st, i) !== "";
}

/** 画成表单（ChatDecisionCard 的 ask.form） */
export function nativeAskForm(qs: NativeQuestion[], st: NativeAskState): ClaudeAsk {
  const tabs = qs.map((q, i) => ({ label: q.header ?? `第 ${i + 1} 题`, answered: answered(st, i) }));
  if (st.current >= qs.length) {
    const unanswered = qs.some((_, i) => !answered(st, i));
    return {
      kind: "review",
      tabs,
      current: qs.length,
      rows: [{ kind: "confirm" }, { kind: "cancel" }],
      cursor: 0,
      answers: qs.map((q, i) => ({ question: q.question, answer: answerOf(st, i) })),
      warning: unanswered ? "还有题没答" : null,
    };
  }
  const q = qs[st.current];
  const rows: AskRow[] = [
    ...q.options.map((_, index) => ({ kind: "option" as const, index })),
    { kind: "free" },
    ...(q.multiSelect ? [{ kind: "submit" as const }] : []),
    { kind: "chat" },
  ];
  return {
    kind: "question",
    tabs,
    current: st.current,
    rows,
    cursor: 0,
    question: q.question,
    multiSelect: q.multiSelect,
    options: q.options.map((o) => ({
      label: o.label,
      description: o.description,
      checked: q.multiSelect ? st.picks[st.current].includes(o.label) : null,
    })),
    freeText: st.free[st.current],
    freeChecked: q.multiSelect ? Boolean(st.free[st.current]?.trim()) : null,
  };
}

function submitAll(qs: NativeQuestion[], st: NativeAskState): NativeAskResult {
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => {
    const a = answerOf(st, i);
    if (a) answers[q.question] = a;
  });
  return { kind: "submit", answers };
}

/** 单选这一题答完：只有一道单选题就直接交，否则到下一题（最后一题后是确认页） */
function advance(qs: NativeQuestion[], st: NativeAskState): { state: NativeAskState; result: NativeAskResult } {
  if (qs.length === 1 && !qs[0].multiSelect) return { state: st, result: submitAll(qs, st) };
  return { state: { ...st, current: st.current + 1 }, result: null };
}

/** 表单上的一次操作 → 新的已选，或最终结果（交答案 / 整组不答） */
export function applyNativeAsk(
  qs: NativeQuestion[],
  st: NativeAskState,
  action: AskAction,
): { state: NativeAskState; result: NativeAskResult } {
  const i = st.current;
  const q = qs[i];
  switch (action.kind) {
    case "pick": {
      if (!q) return { state: st, result: null };
      const label = q.options[action.index]?.label;
      if (!label) return { state: st, result: null };
      if (q.multiSelect) {
        const cur = st.picks[i];
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { state: { ...st, picks: st.picks.map((p, k) => (k === i ? next : p)) }, result: null };
      }
      const s2 = { ...st, picks: st.picks.map((p, k) => (k === i ? [label] : p)), free: st.free.map((f, k) => (k === i ? null : f)) };
      return advance(qs, s2);
    }
    case "text": {
      if (!q) return { state: st, result: null };
      const text = action.text.trim() || null;
      const s2 = {
        ...st,
        free: st.free.map((f, k) => (k === i ? text : f)),
        // 单选题自己写答案 = 不选模型给的那几项
        picks: q.multiSelect ? st.picks : st.picks.map((p, k) => (k === i ? [] : p)),
      };
      if (!q.multiSelect && text) return advance(qs, s2);
      if (q.multiSelect && action.submit) return { state: { ...s2, current: i + 1 }, result: null };
      return { state: s2, result: null };
    }
    case "submit":
      return { state: { ...st, current: Math.min(i + 1, qs.length) }, result: null };
    case "tab":
      return { state: { ...st, current: Math.max(0, Math.min(action.index, qs.length)) }, result: null };
    case "confirm":
      return { state: st, result: submitAll(qs, st) };
    case "chat":
    case "cancel":
      return { state: st, result: { kind: "cancel" } };
  }
}
