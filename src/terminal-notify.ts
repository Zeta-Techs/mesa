/** 终端 OSC 通知（OSC 9 / 777）。抽走后不画进画面。只留标题，限长。
 *  OSC 9;4 是 ConEmu 风格的**进度**序列（kimi 工作中每秒发一次、grok/codebuddy 每轮发），
 *  不是通知：静默吞掉（畸形形态也吞），进度值走 parseOsc9Progress 单独取。 */

const OSC9_RE = /\x1b\]9;([^\x07\x1b]{0,2048}?)(?:\x07|\x1b\\)/g;
const OSC777_RE = /\x1b\]777;([^\x07\x1b]{0,2048}?)(?:\x07|\x1b\\)/g;

export function takeTerminalNotifications(chunk: string): {
  text: string;
  titles: string[];
  /** OSC 9;4 进度序列的最后一次取值（没有则 null）。借鉴 VS Code/Tabby：直通到标签条。 */
  progress: TerminalProgress | null;
} {
  const titles: string[] = [];
  let progress: TerminalProgress | null = null;
  // 先抽 777（只认 notify 子命令，currentdirectory 等其他子命令静默吞掉不弹）
  let text = chunk.replace(OSC777_RE, (_all, raw: string) => {
    if (!/^notify;/i.test(raw)) return "";
    const segs = raw.split(";");
    // notify;<title>[;<body>]：标题段空时回落正文段
    const head = (segs[1] ?? "").trim() || segs.slice(2).join("：");
    const title = titleFrom(head);
    if (title) titles.push(title);
    return "";
  });
  // 再抽 OSC 9：4; 开头的整个家族（含畸形）都不是通知，吞掉并顺手取进度
  text = text.replace(OSC9_RE, (_all, raw: string) => {
    if (/^4;/.test(raw)) {
      const parsed = parseOsc9Progress(raw);
      if (parsed) progress = parsed;
      return "";
    }
    const title = titleFrom(raw);
    if (title) titles.push(title);
    return "";
  });
  return { text, titles, progress };
}

/** 控制字符清掉、限长；空标题返回 null。 */
function titleFrom(raw: string): string | null {
  const title = raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  return title || null;
}

/** ConEmu 风格进度（OSC 9;4;state;progress）。kimi 工作中每秒发 state 3、
 *  grok 每轮发 state 1/-1、结束时 state 0；codebuddy 同源。 */
export interface TerminalProgress {
  /** 0 移除 / 1 正常（带百分比）/ 2 错误 / 3 不定 / 4 暂停 */
  state: number;
  /** 0-100 的完成度；null = 不定（-1 或缺省） */
  progress: number | null;
}

export function parseOsc9Progress(raw: string): TerminalProgress | null {
  if (!/^4;/.test(raw)) return null;
  const parts = raw.split(";");
  const state = Number(parts[1]);
  if (!Number.isInteger(state) || state < 0) return null;
  // 空进度段（"4;1;"）按不定处理，不当 0%（ConEmu 语义：缺省/空 = 不定）
  const value =
    parts.length > 2 && parts[2] !== "" ? Number(parts[2]) : NaN;
  const progress =
    Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  return { state, progress };
}

/** 从 OSC 载荷里取通知标题；不是通知（进度序列等）返回 null。 */
export function notificationTitle(raw: string): string | null {
  if (/^4;/.test(raw)) return null;
  return titleFrom(raw);
}
