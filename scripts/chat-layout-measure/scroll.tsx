// 长对话从底部一直往上翻：每步往上 90px，看视野中间那块是不是正好跟着挪 90px（不是＝内容错位），以及有没有别人改滚动位置
import "../../src/App.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState } from "react";
import ChatSurface from "../../src/components/ChatSurface";
import { useAppStore } from "../../src/store";

useAppStore.setState({ settings: { hiddenProfiles: [] } as never });
const q = new URLSearchParams(location.search);
const which = q.get("c") ?? "p90";
const result: Record<string, unknown> = { which };
let setAll: (m: any[]) => void = () => {};
function Tab({ tail }: { tail: any[] }) {
  const [conv, setConv] = useState<any[]>(tail);
  setAll = setConv;
  return (
    <ChatSurface
      messages={conv} state="idle" syncState="synced" loading={false} active agentId="claude-code"
      cwd="/Users/x/project" running={false} canResume attention="idle" readOnly={false} readonlySupported busy={false}
      skills={[]} mcps={[]} onSend={() => 0} onAllowWrite={() => 0} onOpenTerminal={() => 0} peek={false}
      mesaCommands={[]} hasOlder={false} loadingOlder={false}
    />
  );
}
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 数非本页脚本的 scrollTop 写入
let harnessWriting = false, foreignWrites = 0;
const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
Object.defineProperty(Element.prototype, "scrollTop", { ...desc, set(v: number) {
  if (!harnessWriting && (this as Element).classList?.contains("ccode-chat-scroll")) foreignWrites++;
  desc.set!.call(this, v);
} });
(async () => {
  const all = await (await fetch(`/harness.local/conv-${which}.json`)).json();
  result.messages = all.length;
  createRoot(document.getElementById("root")!).render(<div style={{ height: 1000 }} className="flex flex-col"><Tab tail={all.slice(-40)} /></div>);
  await wait(800);
  const sc = () => document.querySelector(".ccode-chat-scroll") as HTMLElement;
  const t0 = performance.now();
  flushSync(() => setAll(all));
  result.fullCommitMs = Math.round(performance.now() - t0);
  await raf(); await raf();
  result.afterFrameMs = Math.round(performance.now() - t0);
  result.domNodes = document.querySelectorAll("*").length;
  await wait(1200);
  result.atBottom = sc().scrollHeight - sc().scrollTop - sc().clientHeight < 2;
  foreignWrites = 0;
  // 往上滑 5 秒：每帧滚轮 + 往上 90px；看视野中间那块的位置是不是正好挪 90px
  const gaps: number[] = []; let jumps = 0, thumbChanges = 0, lastH = sc().scrollHeight, maxJump = 0;
  let last = await raf(); const start = last;
  while (last - start < 5000 && sc().scrollTop > 0) {
    const el = sc();
    const r = el.getBoundingClientRect();
    const probe = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
    const before = probe?.getBoundingClientRect().top ?? 0;
    const st0 = el.scrollTop;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -90, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    harnessWriting = true; el.scrollTop = st0 - 90; harnessWriting = false;
    const moved = st0 - el.scrollTop;
    await raf();
    const now = await raf();
    gaps.push(now - last); last = now;
    if (probe && probe.isConnected) {
      const after = probe.getBoundingClientRect().top;
      const off = Math.abs(after - before - moved);
      if (off > 2) { jumps++; maxJump = Math.max(maxJump, Math.round(off)); }
    }
    const h = sc().scrollHeight;
    if (Math.abs(h - lastH) > 1) { thumbChanges++; lastH = h; }
  }
  gaps.sort((a, b) => a - b);
  Object.assign(result, {
    frames: gaps.length, p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]), max: Math.round(gaps[gaps.length - 1]),
    longFrames: gaps.filter((g) => g > 34).length, contentJumps: jumps, maxJumpPx: maxJump, thumbChanges, foreignScrollWrites: foreignWrites,
    reachedTop: sc().scrollTop <= 0, domNodesEnd: document.querySelectorAll("*").length,
  });
  (window as any).__result = result;
})();
