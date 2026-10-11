/** 终端行里的本地路径：绝对路径直接可点；相对路径（含 ~ 与 ./ ../ 前缀）命中后
 *  由点击时的存在性校验把关（terminal_link_target），避免画出大量无效下划线。 */

/** 候选词：冒号只允许出现在 Windows 盘符前缀里（行号由独立分组吃掉），
 *  全角标点与中西引号不进词内。起点用 lookbehind（前一个字符是空白/中西引号/
 *  书名号/开括号/全角冒号，或行首）：零宽守卫推进 lastIndex 后边界字符不被吞掉，
 *  「 /a.rs」这类行首单个边界字符后紧跟的路径仍可命中（三轮审查实证）。 */
const CANDIDATE =
  /(?<=(?:^|[\s"'`(（【“‘《「『：]))((?:[A-Za-z]:[\\/]|[~.]{0,2}\/)?[^\s"'`()<>|:：,，;；。、）)】」』》〉…“”‘’（【《「『]*?)(?::(\d{1,6})(?::(\d{1,6}))?)?(?=$|[\s"'`),;:<>|，。；：、）】」』》〉…”’〕])/;

export interface TerminalPathHit {
  text: string;
  path: string;
  /** absolute 直接打开；relative 点击时按标签 cwd 校验存在再打开 */
  kind: "absolute" | "relative";
  line: number | null;
  start: number;
  end: number;
}

/** 句尾标点不算路径的一部分（「文件在 /a/b.」的句点、中文顿号等）。 */
function trimPathTail(path: string): string {
  let p = path;
  while (p.length > 1 && /[.,;:：。；，、]$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

/** 候选词像不像一条能打开的本地路径。保守是为少画下划线，点击时的存在性校验才是终审。 */
function pathKind(cand: string, hasLine: boolean): "absolute" | "relative" | null {
  if (cand.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cand)) return "absolute";
  if (cand.startsWith("~") || cand.startsWith("./") || cand.startsWith("../")) {
    return cand.length > 2 ? "relative" : null;
  }
  if (!cand.includes("/")) return null;
  // 无前缀的相对路径：带行号（src/main.rs:40）或带扩展名（papers/included.md）才算
  if (hasLine) return "relative";
  return /\/[^/]*\.[A-Za-z0-9]{1,8}$/.test(cand) ? "relative" : null;
}

export function terminalPathHits(line: string): TerminalPathHit[] {
  const hits: TerminalPathHit[] = [];
  const re = new RegExp(CANDIDATE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    // 零宽匹配保护必须先于一切 continue：行首是边界字符（空格/引号/;/全角标点）
    // 时正则在 ^ 处返回零长度匹配，若不推进 lastIndex 会原地死循环、冻结 UI
    // （2026-10-11 复核实证：缩进行必现）。守卫放最前，下面的 continue 都安全。
    if (match.index === re.lastIndex) {
      re.lastIndex += 1;
      continue;
    }
    const raw = match[1];
    if (!raw || raw.length < 2) continue;
    const path = trimPathTail(raw);
    if (path.length < 2) continue;
    const kind = pathKind(path, Boolean(match[2]));
    if (!kind) continue;
    const start = match.index + match[0].indexOf(raw);
    const lineNo = match[2] ? Number(match[2]) : null;
    const tailLen =
      match[2] && match[3]
        ? match[2].length + match[3].length + 2
        : match[2]
          ? match[2].length + 1
          : 0;
    const end = start + path.length + tailLen;
    hits.push({
      text: line.slice(start, end),
      path,
      kind,
      line: lineNo,
      start,
      end,
    });
  }
  return hits;
}

export function terminalPathHit(line: string): TerminalPathHit | null {
  return terminalPathHits(line)[0] ?? null;
}

/**
 * 把 hit 的字符下标换算成 xterm 的单元格列号（宽字符占 2 格，字符下标当列号会整体错位）。
 * columns 是链接提供方逐格自算的「每个字符 → 所在单元格列号」数组
 *（getNullCell 复用格 + getWidth/getChars；xterm 6.0.0 编译产物的
 * translateToString 没有 outColumns 参数，不能靠它——2026-10-11 实证）。
 * 返回的起止列号均为 1 起、含端点；换算不了返回 null（调用方放弃这条链接）。
 */
export function hitCellRange(
  hit: TerminalPathHit,
  columns: number[],
): { startX: number; endX: number } | null {
  const startCol = columns[hit.start];
  const endCol = columns[hit.end - 1];
  if (!Number.isInteger(startCol) || !Number.isInteger(endCol)) return null;
  return { startX: startCol + 1, endX: endCol + 1 };
}
