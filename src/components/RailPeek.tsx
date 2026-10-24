import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useAppStore } from "../store";

const TRIGGER_LEAVE = "ccode-rail-peek-trigger-leave";

/**
 * 探出整栏（2026-10-24 用户定 A+D+E，对照稿 docs/design-collapsed-rail-chats-mockup.html）：侧栏收成图标、
 * 或完全隐藏时，项目树临时盖在内容上（不挤动内容），选完一段就收回；侧栏本身的形态不变。
 * 开：悬停图标栏中段空白 / 贴窗口左边缘停一下 / ⌘0（App 管）。收：去了别处（换页、换了正看着的那段、
 * 选了另一个项目）、鼠标离开一会儿、Esc、点到外面。树里正开着菜单或正在改名时，鼠标离开不收。
 */
export function RailPeek({
  left,
  width,
  onClose,
  children,
}: {
  /** 相对所在行容器的左边距（图标栏右边 / 窗口左边） */
  left: number;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const timer = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  /** 正开着右键菜单 / ⋯ 菜单，或光标在树里的输入框（改名）：这时离开是去点菜单、不是不要了 */
  const busy = () => {
    if (document.querySelector('[role="menu"]')) return true;
    const active = document.activeElement;
    return !!(active && ref.current?.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName));
  };
  const closeLater = () => {
    clearTimer();
    timer.current = window.setTimeout(function check() {
      if (pointerInside.current) return;
      if (busy()) {
        timer.current = window.setTimeout(check, 400);
        return;
      }
      onCloseRef.current();
    }, 280);
  };

  // 去了别处就收：点对话（换页 / 换了正看着的那段）、点课题名（进项目页或换项目）
  useEffect(() => {
    const start = useAppStore.getState();
    const snap = {
      page: start.page,
      tab: start.terminalActiveTabId,
      project: start.selectProjectReq,
    };
    return useAppStore.subscribe((s) => {
      if (
        s.page !== snap.page ||
        s.terminalActiveTabId !== snap.tab ||
        (s.selectProjectReq !== snap.project && s.selectProjectReq !== null)
      ) {
        onCloseRef.current();
      }
    });
  }, []);

  // Esc / 点到外面（菜单与触发区除外）收
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="menu"]')) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t)) return;
      if (t.closest?.('[role="menu"], [data-rail-peek-trigger], [role="dialog"]')) return;
      onCloseRef.current();
    };
    // 鼠标在触发区停够、探出来了，却没挪进来就走了：同离开探出层一样收
    const onTriggerLeave = () => closeLater();
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener(TRIGGER_LEAVE, onTriggerLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener(TRIGGER_LEAVE, onTriggerLeave);
      clearTimer();
    };
  }, []);

  return (
    <div
      ref={ref}
      role="navigation"
      aria-label="项目与对话"
      style={{ left, width }}
      onMouseEnter={() => {
        pointerInside.current = true;
        clearTimer();
      }}
      onMouseLeave={() => {
        pointerInside.current = false;
        closeLater();
      }}
      className="ccode-rail-peek ccode-float-surface ccode-sheet-left absolute bottom-[5px] top-0 z-30 flex min-h-0 flex-col overflow-hidden rounded-lg border border-field pt-2"
    >
      {children}
    </div>
  );
}

/**
 * 触发区的悬停：停够一会儿才开（鼠标只是路过图标栏 / 左边缘不算），离开时交给 RailPeek 自己收。
 * 返回挂到触发区上的事件
 */
export function useRailPeekTrigger(delayMs = 320) {
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return {
    "data-rail-peek-trigger": true,
    onMouseEnter: () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        useAppStore.getState().setRailPeekOpen(true);
      }, delayMs);
    },
    onMouseLeave: () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      window.dispatchEvent(new Event(TRIGGER_LEAVE));
    },
  } as const;
}
