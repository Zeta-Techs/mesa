/**
 * 读屏时看字的样子（纯逻辑 + xterm 一行的薄适配）。
 *
 * 多数读屏只看文字（translateToString），有的光看文字认不出、要看样子：
 * - Claude Code 输入框里那行灰字：猜你下一句想说什么（prompt-suggestion.ts），和你自己打的字只差在「灰」。
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
}

/** xterm IBufferCell / IBufferLine 用到的那几个方法（测试里拿假对象顶） */
export interface CellSource {
  getChars(): string;
  getWidth(): number;
  isDim(): number;
  isInverse(): number;
  isBgDefault(): boolean;
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
    out.push({
      ch: cell.getChars() || " ",
      dim: cell.isDim() !== 0,
      inverse: cell.isInverse() !== 0,
      bg: !cell.isBgDefault(),
    });
  }
  return out;
}
