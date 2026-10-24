/**
 * 改动面板（GitPanel）diff 正文的纯逻辑（2026-10-23 用户：diff 查看器怎么完善）；评审页的 diff 解析在 diff-view.ts。
 * 块头从 git 原样的「@@ -339,10 +340,11 @@ 小标题」换成白话「第 340 行 · 小标题」；
 * 改了一部分的行（删一行紧跟加一行）标出改的是哪一段——中文长段落只铺整行红绿，看不出改了哪几个字。
 */

export interface HunkHeader {
  oldStart: number;
  newStart: number;
  /** @@ 后面 git 给的上下文（多半是所在函数名 / Markdown 小标题），没有为空串 */
  context: string;
}

export function parseHunkHeader(header: string): HunkHeader | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(header.trim());
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]), context: m[3].trim() };
}

/** 块头白话：「第 340 行」+ 上下文；解析不了原样返回 */
export function hunkLabel(header: string): { line: string; context: string } {
  const h = parseHunkHeader(header);
  if (!h) return { line: header, context: "" };
  // 纯删除块新文件里行号可能是 0，退回旧行号
  return { line: `第 ${h.newStart || h.oldStart} 行`, context: h.context };
}

/** [start, end) 按 UTF-16 下标，直接给 slice 用 */
export type Range = [number, number];

/**
 * 一对「删 / 加」行里真正改了的那一段：去掉相同的开头和结尾，剩下的就是改动。
 * 一行里改了几处时标出的是从第一处到最后一处的整段——够看出「改在哪」，不做逐词对齐。
 * 改动占了大半行（整句重写）时不标，免得满行高亮等于没标。
 */
export function intralineRanges(oldText: string, newText: string): { old: Range; new: Range } | null {
  if (oldText === newText) return null;
  const a = Array.from(oldText);
  const b = Array.from(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const longer = Math.max(a.length, b.length);
  const changed = longer - pre - suf;
  if (longer === 0 || changed / longer > 0.7) return null;
  // 码点下标换回 UTF-16 下标（表情等代理对字符）
  const u16 = (chars: string[], n: number) => chars.slice(0, n).join("").length;
  return {
    old: [u16(a, pre), u16(a, a.length - suf)],
    new: [u16(b, pre), u16(b, b.length - suf)],
  };
}

/**
 * 给 diff 正文（每行带 +/-/空格 前缀）里成对的删加行算行内高亮：一串连续的「-」紧跟一串连续的「+」，
 * 两边条数相同才逐行配对（条数不同多半是拆合段落，配错比不配更误导）。返回 行下标 → 去掉前缀后的高亮区间。
 */
export function pairIntraline(lines: readonly string[]): Map<number, Range> {
  const out = new Map<number, Range>();
  let i = 0;
  while (i < lines.length) {
    if (!isDel(lines[i])) {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && isDel(lines[i])) i++;
    const addStart = i;
    while (i < lines.length && isAdd(lines[i])) i++;
    const dels = addStart - delStart;
    const adds = i - addStart;
    if (dels !== adds) continue;
    for (let k = 0; k < dels; k++) {
      const r = intralineRanges(lines[delStart + k].slice(1), lines[addStart + k].slice(1));
      if (!r) continue;
      if (r.old[1] > r.old[0]) out.set(delStart + k, r.old);
      if (r.new[1] > r.new[0]) out.set(addStart + k, r.new);
    }
  }
  return out;
}

function isDel(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function isAdd(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}
