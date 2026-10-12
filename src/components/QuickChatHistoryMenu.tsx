import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionMetaDto } from "../types";
import { AGENTS } from "../types";
import { agentBrandBadgeStyle } from "../agent-colors";
import { relTime } from "../rel-time";
import { sessionDisplayTitle } from "../quick-chat";
import { useAnimatedDismiss } from "../exit-animation";

/**
 * 侧栏「快速开聊」右键 = 继续上次（scratch 里的随手聊）。
 * 左键直达时看不到弹层历史，右键是回看口。行样式与弹层「继续上次」一致。
 * 定位/关闭语义与 ContextMenu 一致：点外/Esc/滚动即关，实测后钳制在视口内。
 */
export default function QuickChatHistoryMenu({
  x,
  y,
  sessions,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  sessions: SessionMetaDto[];
  onPick: (s: SessionMetaDto) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ left: number; top: number } | null>(
    null,
  );
  // Esc/点外播退场；滚动关闭和选中会话（commit）保持即时卸载
  const { dismiss, exiting } = useAnimatedDismiss(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // dismiss 是稳定引用（useCallback 仅依赖时长）
  }, [onClose, dismiss]);

  // 实测面板宽高后钳制在视口内（useLayoutEffect 绘制前完成修正，不闪动）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setMeasured({
      left: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [x, y, sessions]);

  const style = measured ?? { left: x, top: y };

  return (
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
        role="menu"
        aria-label="随手聊历史"
        className={`ccode-anchor-topleft absolute w-80 overflow-hidden rounded-md border border-field ccode-float-surface${exiting ? " ccode-exiting" : ""}`}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hairline px-3.5 py-2 text-xs text-l3">
          继续上次
        </div>
        <ul className="max-h-80 space-y-0.5 overflow-auto py-1">
          {sessions.length === 0 ? (
            <li className="px-3.5 py-3 text-xs text-l4">
              还没有 ~/ccode/scratch 里的随手聊
            </li>
          ) : (
            sessions.map((s) => (
              <li key={`${s.agent}:${s.sessionId}`}>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onPick(s);
                  }}
                  title={`${sessionDisplayTitle(s)}\n${AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent} · ${s.projectPath}`}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover"
                >
                  <span
                    className="shrink-0 rounded-sm px-1 py-0.5 text-micro"
                    style={agentBrandBadgeStyle(s.agent)}
                  >
                    {AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-l1">
                    {sessionDisplayTitle(s)}
                  </span>
                  <span className="shrink-0 text-micro text-l4">
                    {relTime(s.updatedAt)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
