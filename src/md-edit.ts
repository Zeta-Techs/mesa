/**
 * md 行内/行级格式编辑纯逻辑（2026-10-14 用户反馈补齐：笔记编辑缺加粗/斜体等
 * md 快捷键与工具行）。输入输出都是「全文 + 选区偏移」，组件层负责与 Monaco
 * 的 offset↔position 换算和 executeEdits 回写；本模块不碰 DOM，node --test 直测。
 *
 * 语义（对齐主流 md 编辑器）：
 * - 行内标记（** * ~~ `）在选区两侧切换：已包裹 → 解除；未包裹 → 包裹；
 *   空选区 → 插入成对标记、光标居中；选区首尾空白留在标记外。
 * - 行级前缀（- / - [ ] / >）对选区覆盖的每一行整组切换。
 * - 回车续列表：光标行是列表项 → 新行继承前缀（任务清单重置为未勾选）；
 *   空列表项回车 → 去掉标记退出列表。
 */

export interface MdEditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/** 把选区首尾空白留在标记外（空选区不动） */
function trimSelection(
  text: string,
  selStart: number,
  selEnd: number,
): { start: number; end: number } {
  let start = selStart;
  let end = selEnd;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** 行内标记切换：** * ~~ ` 等 */
export function toggleInlineMark(
  text: string,
  selStart: number,
  selEnd: number,
  mark: string,
): MdEditResult {
  const len = mark.length;
  // 已包裹 → 解除（选区两侧恰为 mark；首尾空白不参与判定）
  const trimmed = trimSelection(text, selStart, selEnd);
  if (
    trimmed.start >= len &&
    trimmed.end <= text.length - len &&
    text.slice(trimmed.start - len, trimmed.start) === mark &&
    text.slice(trimmed.end, trimmed.end + len) === mark
  ) {
    return {
      text:
        text.slice(0, trimmed.start - len) +
        text.slice(trimmed.start, trimmed.end) +
        text.slice(trimmed.end + len),
      selStart: trimmed.start - len,
      selEnd: trimmed.end - len,
    };
  }
  // 空选区 → 成对插入、光标居中
  if (trimmed.start === trimmed.end) {
    const at = trimmed.start;
    return {
      text: text.slice(0, at) + mark + mark + text.slice(at),
      selStart: at + len,
      selEnd: at + len,
    };
  }
  return {
    text:
      text.slice(0, trimmed.start) +
      mark +
      text.slice(trimmed.start, trimmed.end) +
      mark +
      text.slice(trimmed.end),
    selStart: trimmed.start + len,
    selEnd: trimmed.end + len,
  };
}

/** 任意列表前缀（无序/有序/任务清单，含勾选态）——换标记时先剥掉它，不叠层 */
const ANY_LIST_PREFIX = /^([\t ]*)(?:[-*+](?:[ \t]+\[[ xX]\])?[ \t]+|\d+\.[ \t]+)/;

function listMarkerOf(l: string): { indent: string; marker: string } | null {
  const m = ANY_LIST_PREFIX.exec(l);
  return m ? { indent: m[1], marker: m[0].slice(m[1].length) } : null;
}

/** 行级前缀切换：全部行已有目标前缀 → 整组去掉；否则整组加上——行上已有别的
    列表标记时替换成目标前缀（•↔☑ 互切、已勾选任务行点 ☑ 变回未勾选，不叠双标记）。
    列表族的「已有」按完整标记比对（"- [ ] x" 对 "- " 不算已有，防删出孤儿复选框）；
    引用等非列表前缀按 startsWith 口径 */
export function toggleLinePrefix(
  text: string,
  selStart: number,
  selEnd: number,
  prefix: string,
): MdEditResult {
  const startLine = text.lastIndexOf("\n", selStart - 1) + 1;
  // 选区止点落在行首且非空选区时，那行不算（选到行尾换行为止）
  const endProbe = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  let blockEnd = text.indexOf("\n", endProbe);
  if (blockEnd < 0) blockEnd = text.length;
  const block = text.slice(startLine, blockEnd);
  const lines = block.split("\n");
  const isListPrefix = /^[-*+]/.test(prefix);
  const allHave = isListPrefix
    ? lines.every((l) => listMarkerOf(l)?.marker === prefix)
    : lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => {
      if (allHave) {
        if (!isListPrefix) return l.slice(prefix.length);
        const m = ANY_LIST_PREFIX.exec(l)!; // allHave 已保证匹配
        return m[1] + l.slice(m[0].length);
      }
      const mk = listMarkerOf(l);
      if (mk) return mk.indent + prefix + l.slice(mk.indent.length + mk.marker.length);
      return prefix + l;
    })
    .join("\n");
  // 选区改成覆盖整块受影响行（逐偏移精算在多行前缀增删下得不偿失）
  return {
    text: text.slice(0, startLine) + next + text.slice(blockEnd),
    selStart: startLine,
    selEnd: startLine + next.length,
  };
}

/** 回车续列表的判定结果 */
export type ListContinue =
  | { kind: "none" }
  /** 空列表项：整行清成 clean（保留缩进），光标行首 */
  | { kind: "exit"; clean: string }
  /** 新行前缀（含标记与尾随空格，任务清单重置为未勾选） */
  | { kind: "continue"; prefix: string };

const LIST_RE = /^([\t ]*)(?:([-*+])|(\d+)\.)([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

/** 光标行是否列表项、回车后新行前缀是什么 */
export function continueListItem(line: string): ListContinue {
  const m = LIST_RE.exec(line);
  if (!m) return { kind: "none" };
  const [, indent, bullet, num, sep, checkbox] = m;
  const marker = bullet ?? `${Number(num) + 1}.`;
  // 任务清单：空项退出；有内容续（未勾选）
  if (checkbox) {
    return m[6]
      ? { kind: "continue", prefix: `${indent}${marker}${sep}[ ] ` }
      : { kind: "exit", clean: indent };
  }
  return m[6]
    ? { kind: "continue", prefix: `${indent}${marker}${sep}` }
    : { kind: "exit", clean: indent };
}

/** 选区包成链接：非空选区 → [选区](url) 并选中 url；空选区 → [](url) 光标在方括号内 */
export function wrapAsLink(
  text: string,
  selStart: number,
  selEnd: number,
): MdEditResult {
  const { start, end } = trimSelection(text, selStart, selEnd);
  if (start === end) {
    return {
      text: text.slice(0, start) + "[](url)" + text.slice(start),
      selStart: start + 1,
      selEnd: start + 1,
    };
  }
  const label = text.slice(start, end);
  return {
    text: text.slice(0, start) + `[${label}](url)` + text.slice(end),
    selStart: start + label.length + 3,
    selEnd: start + label.length + 6,
  };
}
