/**
 * 抓屏原文 → Mesa 读屏节奏下的实时预览序列（surface.mjs 的输入）。
 *
 * 把 chat-capture.py（CAP_RAW=1）记下的终端原始输出逐块写进真 xterm.js，照 TerminalView.scanLiveReplyNow 的口径读屏：
 * 出字后 300ms 读一次（节流带尾读）、正在半帧（同步输出没收尾）就 50ms 后再读，交给 src/live-reply.ts 抽出、接起来。
 * 同时按屏上「esc to interrupt」消失的时刻记下回合结束（只对 Claude 有意义，别家用 --end 或交给 surface 用末帧）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/chat-replay/timeline.ts <抓屏.json> <输出.json> [--mark TRIGGER_LONG] [--until 文字] [--end 秒]
 *     --mark   这一轮从原文里第一次出现这串字算起（发出去的那句；默认 TRIGGER_LONG）
 *     --until  预览读到这串字之后再收一帧就停（后面一幕不要；如回复最后一句里的几个字）
 *     --end    手动给回合结束时刻（相对 --mark，秒）
 *   node --experimental-strip-types scripts/chat-replay/timeline.ts --markdown <回复.md> <输出.json> [--chunk 40] [--every 0.12]
 *     不读屏的家（Codex / Qwen / OpenCode 走旁路推 Markdown 实时文字）：按字数切块、匀速流出，生成同形的序列
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { JSDOM } from "jsdom";

const root = new URL("../../", import.meta.url).href;
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mark: { type: "string", default: "TRIGGER_LONG" },
    until: { type: "string" },
    end: { type: "string" },
    markdown: { type: "boolean", default: false },
    chunk: { type: "string", default: "40" },
    every: { type: "string", default: "0.12" },
  },
});
const [inPath, outPath] = positionals;
if (!inPath || !outPath) throw new Error("用法见文件头注释");

type Frame = { t: number; lines: string[]; styled: unknown };

if (opt.markdown) {
  const text = readFileSync(inPath, "utf8").trim();
  const step = Number(opt.chunk);
  const every = Number(opt.every);
  const frames: Frame[] = [];
  let t = 0.6;
  for (let n = 0; n < text.length; ) {
    n = Math.min(text.length, n + step);
    t += every;
    frames.push({ t: +t.toFixed(3), lines: text.slice(0, n).split("\n"), styled: null });
  }
  writeFileSync(outPath, JSON.stringify({ agent: "codex", source: "markdown", endAt: +(t + 0.3).toFixed(3), frames }));
  console.log(`旁路 Markdown 序列 ${frames.length} 帧，回合结束 ${(t + 0.3).toFixed(2)}s`);
  process.exit(0);
}

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, self: dom.window });
const { Terminal } = await import(`${root}node_modules/@xterm/xterm/lib/xterm.mjs`);
const { Unicode11Addon } = await import(`${root}node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs`);
const lr = (await import(`${root}src/live-reply.ts`)) as typeof import("../../src/live-reply.ts");
const sc = (await import(`${root}src/screen-cells.ts`)) as typeof import("../../src/screen-cells.ts");

const cap = JSON.parse(readFileSync(inPath, "utf8")) as { agent: string; size: [number, number]; raw?: [number, string][] };
if (!cap.raw) throw new Error("抓屏里没有原始输出：chat-capture.py 要带 CAP_RAW=1");
const term = new Terminal({ cols: cap.size[0], rows: cap.size[1], allowProposedApi: true, scrollback: 5000 });
// 同 TerminalView：Unicode 11 宽度表（不开时中文标点与 emoji 宽度和 Mesa 里不一样）
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
const chunks = cap.raw.map(([t, b]) => ({ t, data: Buffer.from(b, "base64") }));
const start = chunks.find((c) => c.data.includes(opt.mark!))?.t;
if (start === undefined) throw new Error(`原文里找不到 ${opt.mark}`);

let prev: { lines: string[]; styled: unknown } | null = null;
let echo: string | undefined;
let wasActive = false;
let endAt: number | null = opt.end ? Number(opt.end) + start : null;
let guard = 0;
let stopAfter = false;
const frames: Frame[] = [];
const readAt = (t: number) => {
  const buf = term.buffer.active;
  const lines = Array.from({ length: term.rows }, (_, i) => buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
  const active = lr.claudeTurnActiveOnScreen(lines);
  if (active) wasActive = true;
  if (wasActive && !active && endAt === null) endAt = t;
  const cells = (row: number) => sc.activeScreenCells(term, row);
  const read = lr.extractLiveReply(lines, cap.agent, (row) => sc.italicLine(cells(row)), cells);
  if (!read) return;
  // 回显换了 = 新的一轮，不拿上一轮的开头去补（同 scanLiveReplyNow）
  let base = prev;
  if (read.echo !== undefined) {
    if (read.echo !== echo) base = null;
    echo = read.echo;
  }
  const merged = lr.mergeLiveReplyStyled(base, read);
  if (!merged) return;
  const prevText = prev?.lines.join("\n") ?? "";
  const nextText = merged.lines.join("\n");
  // 半帧缩回旧前缀：先留着旧预览，最多两拍（同 liveShrinkGuardRef）
  if (prevText && nextText.length < prevText.length && prevText.startsWith(nextText) && guard < 2) {
    guard++;
    return;
  }
  guard = 0;
  if (prevText === nextText) return;
  prev = merged;
  frames.push({ t: +(t - start).toFixed(3), lines: merged.lines, styled: merged.styled ?? null });
  if (opt.until && nextText.includes(opt.until)) stopAfter = true;
};

let due: number | null = null;
for (const c of chunks) {
  while (due !== null && c.t >= due) {
    if (term.modes.synchronizedOutputMode) {
      due += 0.05;
      continue;
    }
    readAt(due);
    due = null;
  }
  if (stopAfter) break;
  await new Promise<void>((done) => term.write(c.data, () => done()));
  if (c.t < start) continue;
  if (due === null) due = c.t + 0.3;
}
if (due !== null && !stopAfter) readAt(due);
const end = endAt === null ? null : +(endAt - start).toFixed(3);
writeFileSync(outPath, JSON.stringify({ agent: cap.agent, source: "screen", endAt: end, frames }));
console.log(`预览帧 ${frames.length}，回合结束 ${end ?? "未认出（surface 用末帧，或给 --end）"}，末帧 ${frames.at(-1)?.lines.length ?? 0} 行`);
