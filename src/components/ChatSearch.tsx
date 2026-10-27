import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { chatSearchHits } from "../chat-navigation";
import type { ChatMessageDto } from "../types";
import { imeBlocksEnter } from "../ime-guard";

export default function ChatSearch({ messages, request, hasOlder, loadingOlder, onLoadOlder, onFocus, onClose }: {
  messages: ChatMessageDto[];
  request: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void;
  onFocus: (index: number, query: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const compositionFrame = useRef<number | null>(null);
  const hits = useMemo(() => chatSearchHits(messages, query), [messages, query]);
  const position = Math.max(0, hits.findIndex((hit) => hit.key === selected));
  const current = hits[position];
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, [request]);
  useEffect(() => () => { if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current); }, []);
  useEffect(() => { onFocus(current?.index ?? -1, query.trim()); }, [current?.key, current?.index, query, onFocus]);
  function move(delta: number) {
    if (!hits.length) return;
    setSelected(hits[(position + delta + hits.length) % hits.length].key);
  }
  const button = "flex size-8 shrink-0 items-center justify-center rounded-md text-l2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-cta disabled:opacity-40";
  return <div role="search" aria-label="搜索聊天" className="shrink-0 border-b border-hairline bg-canvas px-3 py-1.5">
    <div className="flex items-center gap-1.5">
      <Search size={14} className="shrink-0 text-l3" aria-hidden="true" />
      <input ref={ref} aria-label="搜索聊天内容" placeholder="搜索消息、命令和输出" value={query}
        className="min-w-0 flex-1 rounded-md border border-field bg-inset px-2 py-1 text-sm text-l1 focus-visible:outline-2 focus-visible:outline-cta"
        onChange={(event) => { setQuery(event.target.value); setSelected(null); }}
        onCompositionStart={() => { composing.current = true; if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current); }}
        onCompositionEnd={() => { compositionFrame.current = requestAnimationFrame(() => { composing.current = false; }); }}
        onKeyDown={(event) => {
          if (imeBlocksEnter({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode, composingLock: composing.current })) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        }} />
      <span className="shrink-0 text-xs tabular-nums text-l3" aria-live="polite">{query.trim() ? `${hits.length ? position + 1 : 0} / ${hits.length} 条` : ""}</span>
      <button type="button" className={button} aria-label="上一条匹配" title="上一条（Shift+Enter）" disabled={!hits.length} onClick={() => move(-1)}><ChevronUp size={15} /></button>
      <button type="button" className={button} aria-label="下一条匹配" title="下一条（Enter）" disabled={!hits.length} onClick={() => move(1)}><ChevronDown size={15} /></button>
      <button type="button" className={button} aria-label="关闭聊天搜索" title="关闭（Esc）" onClick={onClose}><X size={15} /></button>
    </div>
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-l3">
      <span>{hasOlder ? `搜索已加载的 ${messages.length} 条消息` : "搜索整段已读取的对话"}</span>
      {hasOlder && onLoadOlder && <button type="button" className="min-h-7 rounded-md px-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-cta" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? "正在加载更早消息…" : "加载更早消息继续查找"}</button>}
    </div>
  </div>;
}
