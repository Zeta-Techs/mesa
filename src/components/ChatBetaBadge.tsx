import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { chatFidelity, fidelityBadge, tierLabel, verifiedVersion } from "../chat-fidelity";
import { CANARY_PLATFORM, VERIFIED_VERSIONS, useCliNewer } from "../cli-verified";
import { clipBounds, pickPopoverSide } from "../popover-side";

/**
 * 聊天输入框左下的「测试版」（2026-10-22 用户：聊天层要不要标一个测试版）：点开说清楚这一家在聊天里能做到哪一步、
 * 哪些事要回终端；用户装的 CLI 比 Mesa 核对过的新时多一句提醒（chat-fidelity.ts）。只说明，不挡任何操作
 */
export default function ChatBetaBadge({
  agentId,
  onOpenTerminal,
}: {
  agentId: string | null;
  onOpenTerminal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"above" | "below">("above");
  const installed = useAppStore((s) => s.agents.find((a) => a.id === agentId)?.version ?? null);
  const fidelity = chatFidelity(agentId);
  const label = AGENTS.find((a) => a.id === agentId)?.label ?? "这家 Agent";
  const verified = agentId ? verifiedVersion(VERIFIED_VERSIONS, CANARY_PLATFORM, agentId) : null;
  const newer = useCliNewer(agentId);
  const badge = fidelityBadge(fidelity, newer);
  const heading = fidelity?.beta ? "聊天是测试版" : fidelity && fidelity.tier >= 3 ? "这家的聊天是简化的" : "聊天层说明";

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return;
    setSide(pickPopoverSide(rootRef.current.getBoundingClientRect(), clipBounds(rootRef.current), menuRef.current.offsetHeight));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!badge) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${heading}：点开看这一家在聊天里能做到哪一步`}
        className={`ml-1 flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l2 ${
          open ? "bg-hover text-l2" : ""
        }`}
      >
        {badge}
        {newer && <span aria-label="CLI 比核对过的新" className="size-1.5 rounded-full bg-caution-text" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-label={heading}
          className={`absolute left-0 z-30 w-[22rem] rounded-xl border border-field ccode-float-surface p-3 text-xs leading-5 text-l3 shadow-lg ${
            side === "below" ? "top-full mt-2" : "bottom-full mb-2"
          }`}
        >
          <div className="mb-1 text-sm text-l1">{heading}</div>
          <p>聊天是同一个终端会话的另一种看法，以终端为准：聊天里看不到、按不动的，切到终端都在。</p>
          {fidelity && (
            <>
              <p className="mt-2">
                <span className="text-l2">
                  {label} · {tierLabel(fidelity.tier)}
                </span>
                ：{fidelity.source}。
              </p>
              <p className="mt-1">要回终端做的：{fidelity.terminalOnly}。</p>
            </>
          )}
          {newer && (
            <p className="mt-2 text-caution-text">
              你装的 {label} {installed} 比 Mesa 核对过的 {verified} 新：它的画面要是变了，聊天里的确认按钮可能按不准。
              这期间 Mesa 不替你自动按任何一步，按不对就点卡上的「露出终端」自己选。
            </p>
          )}
          {onOpenTerminal && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenTerminal();
                }}
                className="h-7 rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
              >
                切到终端
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
