/**
 * 实时预览回放：把 chat-capture.py（CAP_RAW=1）记下的终端原始输出逐块写进真 xterm.js，每写完一块按 TerminalPage 的口径
 * 读一次屏（一帧没画完时不读，同 scanLiveReplyNow）、交给 src/live-reply.ts 接起来，最后看预览里有没有重复、漏行。
 * 逐块读比 Mesa 300ms 一读更密，接法有毛病时更容易露出来（2026-10-22 用户：Claude Code 长回复预览一遍遍重贴整屏，
 * 旧接法这样回放重复 161 行）。
 *
 * 用法：node --experimental-strip-types scripts/e2e-model-routing/live-replay.ts <抓屏.json> [原文.md]
 *   只回放回复那一幕：从回显里出现 TRIGGER_LONG（或 REPLY_MARK）到出现 TRIGGER_TOOL 为止；
 *   给了原文（假网关 E2E_LONG_FILE 那份）就逐行比：duplicated = 比原文多出来的行，missing = 原文里有、预览里没有的行。
 *   LR=<另一份 live-reply.ts> 换接法比较；SHOW=1 打印接好的预览；NOSYNC=1 半帧也读。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, self: dom.window });
const { Terminal } = await import(`${root}node_modules/@xterm/xterm/lib/xterm.mjs`);
const lr = (await import(process.env.LR ?? `${root}src/live-reply.ts`)) as typeof import("../../src/live-reply.ts");

const [capPath, truthPath] = process.argv.slice(2);
const cap = JSON.parse(readFileSync(capPath, "utf8")) as { agent: string; size: [number, number]; raw: [number, string][] };
if (!cap.raw) throw new Error("抓屏里没有原始输出：chat-capture.py 要带 CAP_RAW=1");
const chunks = cap.raw.map(([t, b64]) => ({ t, data: Buffer.from(b64, "base64") }));
const at = (mark: string) => chunks.find((c) => c.data.includes(mark))?.t ?? null;
const from = at(process.env.REPLY_MARK ?? "TRIGGER_LONG") ?? 0;
const to = at("TRIGGER_TOOL") ?? Infinity;

const [cols, rows] = cap.size;
const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
const write = (b: Uint8Array) => new Promise<void>((done) => term.write(b, () => done()));
let prev: string[] | null = null;
let reads = 0;
let halfFrames = 0;
for (const c of chunks) {
  await write(c.data);
  if (c.t < from || c.t >= to) continue;
  if (!process.env.NOSYNC && term.modes.synchronizedOutputMode) {
    halfFrames++;
    continue;
  }
  const buf = term.buffer.active;
  const lines = Array.from({ length: term.rows }, (_, i) => buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
  const read = lr.extractLiveReply(lines, cap.agent);
  if (!read) continue;
  reads++;
  prev = lr.mergeLiveReply(prev, read) ?? prev;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const result: Record<string, unknown> = { agent: cap.agent, reads, halfFrames, lines: prev?.length ?? 0 };
if (truthPath) {
  const want = new Map<string, number>();
  for (const l of readFileSync(truthPath, "utf8").split("\n")) {
    const k = norm(l);
    if (k) want.set(k, (want.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  let duplicated = 0;
  for (const l of prev ?? []) {
    const k = norm(l);
    if (!k) continue;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k)! > (want.get(k) ?? 1)) duplicated++;
  }
  // 终端会把长行折成几行、代码块的语言标签不画：预览里有包含它或被它包含的行就算有
  const keys = [...seen.keys()];
  const missing = [...want.keys()].filter((k) => k.length > 6 && !keys.some((s) => s.includes(k) || k.includes(s)));
  Object.assign(result, { duplicated, missing: missing.length });
}
console.log(JSON.stringify(result));
if (process.env.SHOW) console.log((prev ?? []).join("\n"));
