/** 确认框键盘语义（tests/confirm-dialog.test.ts）。
 *  焦点在「取消」时 Enter 必须取消；默认焦点是确认钮。 */

export type ConfirmKeyAction = "confirm" | "cancel" | "none";

export function confirmKeyAction(input: {
  key: string;
  alert: boolean;
  focusedIsCancel: boolean;
  enterBlocked: boolean;
}): ConfirmKeyAction {
  if (input.key === "Escape") return "cancel";
  if (input.key !== "Enter" || input.enterBlocked) return "none";
  if (input.alert) return "confirm";
  if (input.focusedIsCancel) return "cancel";
  return "confirm";
}

/* ── 确认框正文结构化（2026-10-17）────────────────────────────────────────────
   126 处调用都只传一段纯文本、靠 \n 排版，整段同字号同颜色读不出层次。不逐处改文案，
   而是组件拿到原文自动认结构：首段短句当标题、成组「键：值」行当对照表、「注意：」
   开头的段当注意条，其余照常是段落。只认全角「：」——半角冒号会误吃路径（C:\）与 URL。 */

export type ConfirmTone = "safe" | "danger" | "neutral";

export type ConfirmBlock =
  | { kind: "text"; text: string }
  | { kind: "facts"; rows: { key: string; value: string; tone: ConfirmTone }[] }
  | { kind: "note"; text: string };

export interface ConfirmContent {
  title: string | null;
  blocks: ConfirmBlock[];
}

/** 标题上限：首段单行且不超过这么多字才当标题，长句留在正文（标题行粗体，太长读着累） */
const TITLE_MAX = 60;
/** 对照表的键上限：超过就不像「项：后果」而像一句带冒号的话 */
const FACT_KEY_MAX = 40;
const FACT_LINE = /^([^：]{1,40})：\s*(\S.*)$/;
const NOTE_PREFIX = /^(注意|提示|说明)：\s*/;

/** 值的后果语气：「保留」类读作安全，「彻底/不可恢复/永久」读作危险，其余中性 */
export function factTone(value: string): ConfirmTone {
  if (/彻底|不可恢复|不能恢复|永久|无法撤销|不可撤销/.test(value)) return "danger";
  if (/^保留|不受影响|不动|不删除/.test(value)) return "safe";
  return "neutral";
}

export function parseConfirmMessage(message: string): ConfirmContent {
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  let title: string | null = null;
  if (
    paragraphs.length > 0 &&
    !paragraphs[0].includes("\n") &&
    paragraphs[0].length <= TITLE_MAX
  ) {
    title = paragraphs.shift()!;
  }
  const blocks: ConfirmBlock[] = paragraphs.map((p) => {
    if (NOTE_PREFIX.test(p)) return { kind: "note", text: p.replace(NOTE_PREFIX, "") };
    const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
    const facts = lines.map((l) => FACT_LINE.exec(l));
    if (
      lines.length >= 2 &&
      facts.every((m) => m && m[1].trim().length <= FACT_KEY_MAX)
    ) {
      return {
        kind: "facts",
        rows: facts.map((m) => ({
          key: m![1].trim(),
          value: m![2].trim(),
          tone: factTone(m![2]),
        })),
      };
    }
    return { kind: "text", text: p };
  });
  return { title, blocks };
}

/** 危险操作的按钮文字：调用方没给时从标题里取动词（「删除…？」→「删除」），
 *  让按钮说清点下去会发生什么；取不到才回落「确认」。非危险操作不推断。 */
const DANGER_VERBS = [
  "删除",
  "清除",
  "移除",
  "清空",
  "丢弃",
  "放弃",
  "覆盖",
  "重置",
  "撤销",
  "解绑",
  "停止",
  "关闭",
  "归档",
  "卸载",
  "取消保留",
] as const;

export function inferConfirmText(
  title: string | null,
  danger: boolean,
  explicit: string | undefined,
): string {
  if (explicit) return explicit;
  if (!danger || !title) return "确认";
  // 取标题里最早出现的动词，「只移除…不删除…」这种取「移除」而不是「删除」
  let best: { verb: string; at: number } | null = null;
  for (const verb of DANGER_VERBS) {
    const at = title.indexOf(verb);
    if (at >= 0 && (!best || at < best.at)) best = { verb, at };
  }
  return best?.verb ?? "确认";
}
