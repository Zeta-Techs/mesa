import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SquareTerminal } from "lucide-react";
import { useAppStore } from "../store";
import { useAnimatedDismiss } from "../exit-animation";
import {
  RUN_ACTIVITY_STATE_LABEL,
  runActivitySummary,
  type RunActivityAgent,
  type RunActivitySummary,
} from "../shell-context";
import { AGENTS } from "../types";

/** 运行摘要（顶栏芯片 / 灵动岛胶囊共用同一份口径） */
export function useRunActivity(): RunActivitySummary {
  const inputs = useAppStore((s) => s.terminalRunInputs);
  const liveCount = useAppStore((s) => Object.keys(s.liveSessions).length);
  return runActivitySummary(inputs, liveCount);
}

const DOT: Record<RunActivityAgent["state"], string> = {
  confirm: "bg-warn-text",
  working: "bg-ok-text animate-pulse",
  done: "bg-l4",
  running: "bg-ok-text",
};

/** 运行活动入口：一枚芯片报「谁在跑 / 谁在等你」，点开是 agent 列表、点行直达那个终端标签。
 *  取代旧「N 运行中」——那只是个跳页按钮，看不到哪个 agent 在等确认。
 *  没有在跑的就不渲染（无状态不占位）。variant 只管外形：顶栏是平铺小按钮，岛上是岛内胶囊。 */
export function RunActivityButton({
  variant,
  tabIndex,
}: {
  variant: "titlebar" | "island";
  tabIndex?: number;
}) {
  const summary = useRunActivity();
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );
  if (summary.tone === "idle") return null;
  const dot =
    summary.tone === "confirm" ? "bg-warn-text" : "bg-ok-text animate-pulse";
  return (
    <>
      <button
        type="button"
        tabIndex={tabIndex}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title={
          summary.tone === "confirm"
            ? "有 Agent 在等你确认，点开看是哪个"
            : "正在运行的 Agent，点开可直达对应终端"
        }
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: r.left, top: r.bottom + 6 });
        }}
        className={
          variant === "island"
            ? `ccode-top-nav-item shrink-0 ${summary.tone === "confirm" ? "text-warn-text" : ""}`
            : `flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-micro hover:bg-hover hover:text-l1 ${
                summary.tone === "confirm" ? "text-warn-text" : "text-l3"
              }`
        }
      >
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        {summary.label}
      </button>
      {anchor && (
        <RunActivityPanel
          left={anchor.left}
          top={anchor.top}
          summary={summary}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function RunActivityPanel({
  left,
  top,
  summary,
  onClose,
}: {
  left: number;
  top: number;
  summary: RunActivitySummary;
  onClose: () => void;
}) {
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [left, top]);

  useEffect(() => {
    panelRef.current
      ?.querySelector<HTMLElement>("[data-run-row]")
      ?.focus({ preventScroll: true });
  }, []);

  function go(tabId?: string) {
    const s = useAppStore.getState();
    s.setPage("terminal");
    if (tabId) s.setFocusTabReq(tabId);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[data-run-row]"),
    );
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const d = e.key === "ArrowDown" ? 1 : -1;
    list[(i + d + list.length) % list.length].focus();
  }

  // 挂到 body：灵动岛带 transform + backdrop-filter，会把 fixed 子元素的定位基准改成岛自己
  return createPortal(
    <div
      className={`fixed inset-0 z-50${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="正在运行的 Agent"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={pos}
        className={`ccode-anchor-topleft ccode-float-surface absolute w-80 rounded-lg border border-field${exiting ? " ccode-exiting" : ""}`}
      >
        <div className="flex h-10 items-center gap-1.5 px-3">
          <span className="text-xs font-medium text-l1">正在运行</span>
          <span className="text-micro text-l3">{summary.running}</span>
          {summary.confirm > 0 && (
            <span className="ml-1 text-micro text-warn-text">
              {summary.confirm} 个等你确认
            </span>
          )}
        </div>
        {summary.agents.length > 0 && (
          <div className="max-h-[min(22rem,60vh)] overflow-y-auto border-t border-hairline p-1.5">
            {summary.agents.map((a) => (
              <button
                key={a.tabId}
                type="button"
                data-run-row
                onClick={() => go(a.tabId)}
                className="ccode-menu-item flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${DOT[a.state]}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-l1">{a.label}</span>
                  <span className="block truncate text-micro text-l3">
                    {AGENTS.find((x) => x.id === a.agentId)?.label ?? a.agentId}
                    {" · "}
                    {a.where}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-micro ${
                    a.state === "confirm" ? "text-warn-text" : "text-l3"
                  }`}
                >
                  {RUN_ACTIVITY_STATE_LABEL[a.state]}
                </span>
              </button>
            ))}
          </div>
        )}
        {summary.external > 0 && (
          <p className="border-t border-hairline px-3 py-2 text-micro text-l3">
            {summary.external} 个会话在 Mesa 之外的终端里跑，这里没有标签可跳
          </p>
        )}
        <div className="border-t border-hairline p-1.5">
          <button
            type="button"
            data-run-row
            onClick={() => go()}
            className="ccode-menu-item flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-l2 hover:bg-hover hover:text-l1 focus-visible:bg-hover"
          >
            <SquareTerminal size={13} strokeWidth={1.8} className="shrink-0 text-l3" aria-hidden="true" />
            打开运行页
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 灵动岛休眠面用的被动版：只报状态、不可点。休眠面上的控件鼠标根本点不到
 *  （指针一进岛就展开、休眠面被藏），所以那里只放展示，可点的胶囊在展开面。 */
export function RunActivityStatus() {
  const summary = useRunActivity();
  if (summary.tone === "idle") return null;
  return (
    <span
      className={`ccode-nav-island-status ${
        summary.tone === "confirm" ? "ccode-nav-island-status-warn" : ""
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          summary.tone === "confirm" ? "bg-warn-text" : "bg-ok-text animate-pulse"
        }`}
        aria-hidden="true"
      />
      {summary.label}
    </span>
  );
}
