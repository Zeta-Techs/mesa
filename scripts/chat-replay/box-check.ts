/**
 * 输入框认不认得出：把抓屏原文逐块写进真 xterm.js，每块（不在半帧上）按 Mesa 口径调 terminalHasInputBox，
 * 报「认出过输入框之后又读成没有」几次（那时终端静 4 秒就会弹「终端在等你」、实时预览也读不出），并打印前几处的屏底。
 *
 * 2026-11-25 用它查出 Claude / Qwen / Grok 会话起名（/rename）后输入框上沿写着名字、原先认不出（promptTopRule / BOX_TOP）。
 *
 * 用法：node --experimental-strip-types scripts/chat-replay/box-check.ts <抓屏.json> [更多抓屏.json …]
 */
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../../", import.meta.url).href;
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, self: dom.window });
const { Terminal } = await import(`${root}node_modules/@xterm/xterm/lib/xterm.mjs`);
const { Unicode11Addon } = await import(`${root}node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs`);
const lr = (await import(`${root}src/live-reply.ts`)) as typeof import("../../src/live-reply.ts");

let bad = 0;
for (const path of process.argv.slice(2)) {
  if (!existsSync(path)) {
    console.log(`${path}：没有这个文件`);
    continue;
  }
  const cap = JSON.parse(readFileSync(path, "utf8")) as { agent: string; size: [number, number]; raw?: [number, string][] };
  if (!cap.raw) {
    console.log(`${cap.agent}：抓屏没带原文（CAP_RAW=1）`);
    continue;
  }
  const term = new Terminal({ cols: cap.size[0], rows: cap.size[1], allowProposedApi: true, scrollback: 5000 });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  let seen = false;
  let lost = 0;
  let reads = 0;
  let last: boolean | null | undefined;
  const samples: string[][] = [];
  for (const [t, b64] of cap.raw) {
    await new Promise<void>((done) => term.write(Buffer.from(b64, "base64"), () => done()));
    if (term.modes.synchronizedOutputMode) continue;
    const buf = term.buffer.active;
    const lines = Array.from({ length: term.rows }, (_, i) => buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
    const box = lr.terminalHasInputBox(lines, cap.agent);
    reads++;
    if (box === true) seen = true;
    if (box === false && seen) {
      lost++;
      if (last !== false && samples.length < 3) samples.push([`t=${t}`, ...lines.filter((l) => l.trim()).slice(-8)]);
    }
    last = box;
  }
  if (lost) bad++;
  const table = last === null ? "无画面布局表（不按读屏判断输入框）" : "有画面布局表";
  console.log(`${cap.agent}：读屏 ${reads} 次，${table}，认出过输入框 ${seen}，之后读成没有 ${lost} 次，末屏 ${last}`);
  for (const s of samples) {
    console.log(s.map((l) => `   ${JSON.stringify(l.length > 110 ? `${l.slice(0, 60)}…${l.slice(-40)}` : l)}`).join("\n"));
  }
}
process.exit(bad ? 1 : 0);
