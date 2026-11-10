import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeftRight, ChevronDown, ChevronRight } from "lucide-react";
import { useAppStore } from "../store";
import { relayCardText, type RelayPrompt } from "../chat-relay";
import type { ChatMessageDto } from "../types";
import { AGENTS } from "../types";

interface RelaySegmentDto {
  parentAgent: string;
  parentSession: string;
  parentTitle: string | null;
  parentFile: string | null;
  kind: string;
  messages: ChatMessageDto[];
  moreBefore: boolean;
}

/**
 * 聊天里接力那一句前面的卡（docs/design-chat-relay.md §3.4）：「前面由 Codex 做」/「你离开期间 Codex 做了 2 轮」，
 * 点开摆前一段交出前的最后几轮（只读），旁边能看这次的交接简报。抬头本身不当人话显示。
 * 前一段里又有接力卡的，点开还能再往前看（一层一层按需取，不一次读全链）
 */
export default function ChatRelayCard({
  prompt,
  cwd,
  renderMessages,
}: {
  prompt: RelayPrompt;
  cwd?: string | null;
  renderMessages: (messages: ChatMessageDto[]) => ReactNode;
}) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const [open, setOpen] = useState(false);
  const [seg, setSeg] = useState<RelaySegmentDto | null | "missing">(null);
  const [loading, setLoading] = useState(false);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && seg === null && prompt.briefName && !loading) {
      setLoading(true);
      invoke<RelaySegmentDto | null>("relay_segment", { briefName: prompt.briefName })
        .then((s) => setSeg(s ?? "missing"))
        .catch(() => setSeg("missing"))
        .finally(() => setLoading(false));
    }
  };
  const briefPath = prompt.briefName && cwd ? `${cwd.replace(/[\\/]+$/, "")}/.ccode/${prompt.briefName}` : null;
  const label = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
  return (
    <div className="my-1 ccode-chat-meta text-l4">
      <div className="flex items-center gap-1.5">
        <ArrowLeftRight size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <button
          type="button"
          onClick={toggle}
          title="展开前面那段"
          className="flex min-w-0 items-center gap-0.5 hover:text-l2"
        >
          <span className="truncate">{relayCardText(prompt)}</span>
          {open ? <ChevronDown size={13} strokeWidth={1.8} /> : <ChevronRight size={13} strokeWidth={1.8} />}
        </button>
        {briefPath && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-l2"
              title={briefPath}
              onClick={() => setPreviewReq({ path: briefPath, name: prompt.briefName ?? "", root: cwd ?? "" })}
            >
              {prompt.delta ? "补充简报" : "交接简报"}
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="mt-1.5 max-h-[28rem] overflow-auto rounded-lg border border-hairline px-3 py-2">
          {loading && <p>读取中…</p>}
          {seg === "missing" && <p>前面那段的记录找不到了</p>}
          {seg && seg !== "missing" && (
            <>
              <p className="mb-1">
                {label(seg.parentAgent)} 交出前的最后 {seg.messages.length} 条
              </p>
              {seg.messages.length === 0 ? <p>没有可显示的记录</p> : renderMessages(seg.messages)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
