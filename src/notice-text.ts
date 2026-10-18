/**
 * 提示条 / 浮动提示的正文结构化（2026-10-17）：很多操作结果是一整段长句
 * （如「已获取 424 个模型（openai）。网关只返回模型 ID…。能力声明用…。绑定里…」），
 * 原样整段绿字铺开，读不出「发生了什么」和「接下来要知道什么」。
 * 不逐处改文案：首句当标题（结果），其余按句拆成说明行。与 confirm-dialog.ts 同一思路。
 */

/** 首句当标题的长度上限：再长就不像结论而是一段话，整段当标题、不硬拆 */
const HEADLINE_MAX = 48;

export function splitNoticeText(text: string): { headline: string; details: string[] } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { headline: "", details: [] };
  // 已经自己分行的文案：第一行是标题，其余行照原样
  if (normalized.includes("\n")) {
    const [first, ...rest] = normalized.split("\n").map((l) => l.trim());
    return {
      headline: stripEnd(first ?? ""),
      details: rest.filter(Boolean),
    };
  }
  // 按中文句末标点拆（保留标点在句尾）；半角句点不拆——会误伤版本号、文件名与网址
  const sentences = normalized
    .split(/(?<=[。！？；])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length < 2 || sentences[0]!.length > HEADLINE_MAX) {
    return { headline: normalized, details: [] };
  }
  return { headline: stripEnd(sentences[0]!), details: sentences.slice(1) };
}

function stripEnd(s: string): string {
  return s.replace(/[。；]$/, "");
}

/** 浮动提示停留时长：短句照旧，长句按字数延长（原来一律 3.2 秒，长说明还没读完就没了）。 */
export function noticeDurationMs(text: string, tone: string): number {
  const base = tone === "error" ? 6000 : 3200;
  const extra = Math.max(0, [...text].length - 24) * 60;
  return Math.min(12000, base + extra);
}
