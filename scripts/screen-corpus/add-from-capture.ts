/**
 * 从金丝雀 / chat-capture.py 抓下的逐帧画面里挑几屏存进抓屏语料库（tests/fixtures/screens/<agent>/）。
 * expect 按**当前**解析器读出的结果写——存之前人要看一眼：读对了才存；读错了先修解析器再存，或者手改 expect 写成该读出的样子。
 *
 * 用法：node --experimental-strip-types scripts/screen-corpus/add-from-capture.ts <screen.json> [--version 2.1.306] [--platform darwin] [--dry]
 * 每份抓屏挑三屏：审批菜单（tool 幕最后一帧认得出菜单的）、边写边显示（reply 幕读到最长预览的）、写完回到输入框（reply 幕最后一帧）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRow, readScreen, type ScreenFixture } from "./corpus.ts";
import { parseTuiMenu } from "../../src/tui-menu.ts";
import { extractLiveReply } from "../../src/live-reply.ts";

interface Frame {
  t: number;
  lines: string[];
}
interface Capture {
  agent: string;
  tier: string;
  scenes: Record<string, Frame[]>;
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("用法：add-from-capture.ts <screen.json> [--version x.y.z] [--platform darwin] [--dry]");
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const dry = args.includes("--dry");
const cap = JSON.parse(readFileSync(file, "utf8")) as Capture;
const version = opt("version");
const platform = opt("platform") ?? process.platform;
const dir = join("tests", "fixtures", "screens", cap.agent);

function save(name: string, note: string, lines: string[], keys: (keyof ScreenFixture["expect"])[]) {
  const rows = lines.map(normalizeRow);
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  const fixture: ScreenFixture = {
    agent: cap.agent,
    cliVersion: version,
    platform,
    source: `chat-capture ${cap.tier}`,
    note,
    rows,
    expect: readScreen(cap.agent, rows, keys),
  };
  const out = join(dir, `${platform}-${version ?? "unknown"}-${name}.json`);
  console.log(`${dry ? "（试跑）" : ""}${out}\n${JSON.stringify(fixture.expect, null, 1)}\n`);
  if (!dry) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  }
}

const tool = cap.scenes.tool ?? [];
const menuFrame = [...tool].reverse().find((f) => parseTuiMenu(f.lines) !== null);
if (menuFrame) save("approval-menu", "跑命令前的审批菜单：问句、选项、默认高亮", menuFrame.lines, ["menu", "inputBox"]);

const reply = cap.scenes.reply ?? [];
let best: Frame | null = null;
let bestLen = 0;
for (const f of reply) {
  const n = extractLiveReply(f.lines, cap.agent)?.lines.length ?? 0;
  if (n > bestLen) {
    best = f;
    bestLen = n;
  }
}
if (best) save("live-reply", "生成中：读得出这一轮正在写的段落", best.lines, ["liveReply", "menu"]);
const last = reply.at(-1);
if (last) save("idle", "这一轮写完、回到输入框：看得见输入框，没有菜单", last.lines, ["inputBox", "menu"]);
