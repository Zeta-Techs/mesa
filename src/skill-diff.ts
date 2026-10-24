import { lineDiff, type DiffLine } from "./tool-activity.ts";

/** 内置技能「本机与新版对照」的差异：只画改了的地方。换行统一成 LF 再比（Windows 上本机副本常是 CRLF，
 *  不统一会整份都算改了）；中间连续没改的行折成「⋯」，改动前后各留 ctx 行。 */
export function skillFileDiff(
  current: string,
  proposed: string,
  ctx = 2,
): { lines: DiffLine[]; added: number; removed: number } {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n");
  const raw = lineDiff(norm(current), norm(proposed));
  const lines: DiffLine[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].op !== " ") {
      lines.push(raw[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < raw.length && raw[j].op === " ") j++;
    const run = raw.slice(i, j);
    const atStart = i === 0 || raw[i - 1].op === "~";
    const atEnd = j === raw.length || raw[j].op === "~";
    const keepHead = atStart ? 0 : ctx;
    const keepTail = atEnd ? 0 : ctx;
    if (run.length > keepHead + keepTail + 1) {
      lines.push(...run.slice(0, keepHead));
      if (lines[lines.length - 1]?.op !== "~") lines.push({ op: "~", text: "" });
      lines.push(...run.slice(run.length - keepTail));
    } else {
      lines.push(...run);
    }
    i = j;
  }
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.filter((l) => l.op === "-").length;
  return added + removed === 0 ? { lines: [], added, removed } : { lines, added, removed };
}
