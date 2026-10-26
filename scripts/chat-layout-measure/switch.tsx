// 切到一段对话之后，画面上的字还动不动：第一帧出字起逐帧（画完那一下）看视野里三个探针点下的字，换了就记一次
import "../../src/App.css";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import ChatSurface from "../../src/components/ChatSurface";
import { useAppStore } from "../../src/store";
import type { ChatMessageDto } from "../../src/types";

useAppStore.setState({ settings: { hiddenProfiles: [] } as never });
const q = new URLSearchParams(location.search);
const which = q.get("c") ?? "p90";
// full：整段一次到（看过的、点开前等过的）；page：先到最近一页，rest 毫秒后整段接上
const mode = q.get("mode") ?? "full";
const restMs = Number(q.get("rest") ?? 120);
let ALL: ChatMessageDto[] = [];

function Tab() {
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(mode === "page");
  useEffect(() => {
    const t1 = setTimeout(() => setConv(mode === "page" ? ALL.slice(-40) : ALL), 30);
    const t2 =
      mode === "page"
        ? setTimeout(() => {
            setConv(ALL);
            setLoadingOlder(false);
          }, 30 + restMs)
        : 0;
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  return (
    <ChatSurface
      {...({
        messages: conv, state: "idle", syncState: conv.length ? "synced" : "waiting", loading: false, active: true,
        agentId: "claude-code", cwd: "/Users/x/project", running: false, canResume: true, attention: "idle",
        readOnly: false, readonlySupported: true, busy: false, skills: [], mcps: [], onSend: () => 0,
        onAllowWrite: () => 0, onOpenTerminal: () => 0, peek: false, mesaCommands: [], hasOlder: false,
        loadingOlder, recordPending: !conv.length,
      } as never)}
    />
  );
}

// 画完那一下再量：rAF 回调跑在 ResizeObserver 校正之前，那时的位置还不是真正画上屏的。
// 画完到量之间插进了别的任务（晚到的内容）就不算这一帧：量到的是下一帧绘制前会被校正掉的中间态
const mc = new MessageChannel();
let pending: ((painted: boolean) => void) | null = null;
let rafAt = 0;
mc.port1.onmessage = () => {
  const f = pending;
  pending = null;
  f?.(performance.now() - rafAt < 6);
};
const afterPaint = () =>
  new Promise<boolean>((r) =>
    requestAnimationFrame(() => {
      rafAt = performance.now();
      pending = r;
      mc.port2.postMessage(0);
    }),
  );

(async () => {
  ALL = await (await fetch(`/harness.local/conv-${which}.json`)).json();
  createRoot(document.getElementById("root")!).render(
    <div style={{ height: 1000 }} className="flex flex-col">
      <Tab />
    </div>,
  );
  const t0 = performance.now();
  const T = () => Math.round(performance.now() - t0);
  let firstText = -1;
  let moves = 0;
  let last = "";
  const log: string[] = [];
  while (performance.now() - t0 < 2500) {
    if (!(await afterPaint())) continue;
    const sc = document.querySelector(".ccode-chat-scroll") as HTMLElement | null;
    if (!sc) continue;
    const r = sc.getBoundingClientRect();
    const probe = (y: number) => {
      const rg = (document as unknown as { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint(
        r.left + r.width / 2,
        r.top + y,
      );
      if (!rg || rg.startContainer.nodeType !== 3 || !sc.contains(rg.startContainer)) return "";
      const t = (rg.startContainer as Text).data;
      return t.slice(Math.max(0, rg.startOffset - 6), rg.startOffset + 6);
    };
    const fp = [probe(120), probe(350), probe(Math.max(10, sc.clientHeight - 60))].join("|");
    if (!fp.replace(/\|/g, "")) continue;
    if (firstText < 0) firstText = T();
    else if (fp !== last) {
      moves++;
      if (log.length < 10) log.push(`${T()}ms 「${last}」→「${fp}」 高${sc.scrollHeight}`);
    }
    last = fp;
  }
  (window as unknown as { __result: unknown }).__result = { which, mode, firstTextMs: firstText, visibleMoves: moves, log };
})();
