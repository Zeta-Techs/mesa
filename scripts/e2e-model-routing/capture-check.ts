/**
 * 读屏兜底核对：把 chat-capture.py 抓下的逐帧画面交给 Mesa 自己的解析器（src/tui-menu.ts、src/live-reply.ts），
 * 看实时预览读不读得出流式回复、审批菜单认不认得出来。用来比 macOS 与 Windows（ConPTY）抓到的画面是否同样可读。
 *
 * 用法：node --experimental-strip-types scripts/e2e-model-routing/capture-check.ts <抓屏.json> [...]
 * 每份输出一行结论：reply 幕里读到的最长预览、tool 幕里认出的菜单（问句 + 选项）。
 */
import { readFileSync } from "node:fs";
import { parseTuiMenu } from "../../src/tui-menu.ts";
import { extractLiveReply, liveReplySupported } from "../../src/live-reply.ts";

interface Frame {
  t: number;
  lines: string[];
}
interface Capture {
  agent: string;
  tier: string;
  scenes: Record<string, Frame[]>;
  probe_created?: boolean;
}

for (const file of process.argv.slice(2)) {
  const cap = JSON.parse(readFileSync(file, "utf8")) as Capture;
  const reply = cap.scenes.reply ?? [];
  let best: string[] = [];
  for (const f of reply) {
    const read = extractLiveReply(f.lines, cap.agent);
    if (read && read.lines.length > best.length) best = read.lines;
  }
  const menus = (cap.scenes.tool ?? [])
    .map((f) => parseTuiMenu(f.lines))
    .filter((m) => m !== null);
  const menu = menus.at(-1) ?? null;
  console.log(
    JSON.stringify({
      file,
      agent: cap.agent,
      tier: cap.tier,
      liveReplySupported: liveReplySupported(cap.agent),
      replyFrames: reply.length,
      bestPreviewLines: best.length,
      previewSample: best.slice(0, 3),
      toolFrames: (cap.scenes.tool ?? []).length,
      menuFrames: menus.length,
      menu: menu && { question: menu.question, options: menu.options, selected: menu.selected },
      probeCreated: cap.probe_created ?? null,
    }),
  );
}
