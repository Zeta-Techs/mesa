/**
 * 读屏时看字的样子（纯逻辑 + xterm 一行的薄适配）。
 *
 * 多数读屏只看文字（translateToString），有两处光看文字认不出、要看样子：
 * - Claude Code 输入框里那行灰字：猜你下一句想说什么（prompt-suggestion.ts），和你自己打的字只差在「灰」；
 * - Claude 提问菜单的题签行「☐ 颜色  ☐ 水果  ✔ Submit」：当前在哪一题只靠底色标出来（tui-ask.ts）；
 * - Kimi 选择器每一项下面一行灰字说明，和选项同一缩进，只差在字色（tui-menu.ts）。
 */

/** 画面上的一个字（宽字符占两格，这里只算一个） */
export interface ScreenCell {
  ch: string;
  /** 暗淡（SGR 2）：Ink 的 dimColor */
  dim: boolean;
  /** 反色（SGR 7）：Claude 用它画假光标 */
  inverse: boolean;
  /** 有自己的底色（不是终端默认底） */
  bg: boolean;
  /** 斜体（SGR 3）：Kimi 的思考正文；来源给不出时没有这一项 */
  italic?: boolean;
  /** 字色（颜色模式:值），终端默认色为 null；来源给不出字色时没有这一项 */
  fg?: string | null;
}

/** xterm IBufferCell / IBufferLine 用到的那几个方法（测试里拿假对象顶） */
export interface CellSource {
  getChars(): string;
  getWidth(): number;
  isDim(): number;
  isInverse(): number;
  isBgDefault(): boolean;
  isItalic?(): number;
  getFgColor?(): number;
  getFgColorMode?(): number;
  isFgDefault?(): boolean;
}
export interface LineSource {
  readonly length: number;
  getCell(x: number): CellSource | undefined;
}

export function lineCells(line: LineSource | undefined): ScreenCell[] {
  if (!line) return [];
  const out: ScreenCell[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    // 宽字符的第二格宽度为 0
    if (!cell || cell.getWidth() === 0) continue;
    const item: ScreenCell = {
      ch: cell.getChars() || " ",
      dim: cell.isDim() !== 0,
      inverse: cell.isInverse() !== 0,
      bg: !cell.isBgDefault(),
    };
    if (cell.isItalic) item.italic = cell.isItalic() !== 0;
    if (cell.getFgColor && cell.getFgColorMode && cell.isFgDefault) {
      item.fg = cell.isFgDefault() ? null : `${cell.getFgColorMode()}:${cell.getFgColor()}`;
    }
    out.push(item);
  }
  return out;
}

/**
 * 这一行的字都是斜体（行首的状态点「●」不算，它单独上色、不带斜体）：Kimi 收起的思考整段是斜体浅字，
 * 和回复正文只差在这里（live-reply.ts Layout.thinkItalic）。没有字、或来源给不出斜体时为 false
 */
export function italicLine(cells: readonly ScreenCell[]): boolean {
  const text = cells.filter((c) => c.ch.trim() !== "");
  const body = text[0]?.ch === "●" ? text.slice(1) : text;
  return body.length > 0 && body.every((c) => c.italic === true);
}
