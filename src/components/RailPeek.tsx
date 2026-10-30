import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAppStore } from "../store";

const TRIGGER_LEAVE = "ccode-rail-peek-trigger-leave";

/**
 * 探出整栏（2026-10-24 用户定 A+D+E，对照稿 docs/design-collapsed-rail-chats-mockup.html）：侧栏收成图标、
 * 或完全隐藏时，项目树临时盖在内容上（不挤动内容）；侧栏本身的形态不变。
 * 开：悬停图标栏中段空白 / 贴窗口左边缘停一下 / ⌘0（App 管）。收：鼠标离开一会儿、Esc、点到外面；
 * 去了别处（换页、换了正看着的那段、选了另一个项目）时，鼠标还在里面就先不收（2026-10-25 用户：点了不要立马收，
 * 移开再收），鼠标不在里面（⌘0 键盘选的）才立刻收。树里正开着菜单或正在改名时，鼠标离开不收。
 */
export function RailPeek({
  left,
  width,
  closing = false,
  onClose,
  children,
}: {
  /** 正在播收起（App 用 useExitRender 多挂一会儿）：这时不接鼠标，样式退回藏着的位置 */
  closing?: boolean;
  /** 相对所在行容器的左边距（图标栏右边 / 窗口左边） */
  left: number;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 动画用过渡不用关键帧（2026-10-24 用户：「弹出和收起的动画丝滑一点」）：挂上那一帧先停在藏着的位置，
  // 下一帧再翻到 shown，过渡才有起点；收起时翻回去。过渡可以半路改向，滑出一半又被叫回不会跳
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { returnFocus.current = document.activeElement as HTMLElement | null; }, []);
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
    if (document.querySelector('[role="menu"]') || ref.current?.querySelector("[data-rail-search-open]")) return true;
    const active = document.activeElement;
    return !!(active && ref.current?.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName));
  };
  // 离开后 0.2 秒收（2026-10-30 用户「更跟手」：0.28 → 0.2；够鼠标划出边缘再回来，不至于拖泥带水）
  const closeLater = () => {
    clearTimer();
    timer.current = window.setTimeout(function check() {
      if (pointerInside.current) return;
      if (busy()) {
        timer.current = window.setTimeout(check, 400);
        return;
      }
      onCloseRef.current();
    }, 200);
  };

  // 去了别处就收：点对话（换页 / 换了正看着的那段）、点课题名（进项目页或换项目）；鼠标还在探出层里就不收，
  // 等它移开（onMouseLeave → closeLater）。
  // 收起要播动画、这段时间组件还挂着，而 onClose 自己就改 store（railPeekOpen）——不设「只收一次」会在 store 回调里
  // 递归到栈溢出（界面渲染出错）；收起中不监听，半路又被叫回（closing 翻回 false）时重新拍快照，不拿旧页面当基准
  useEffect(() => {
    if (closing) return;
    const start = useAppStore.getState();
    const snap = {
      page: start.page,
      tab: start.terminalActiveTabId,
      project: start.selectProjectReq,
    };
    let fired = false;
    return useAppStore.subscribe((s) => {
      if (fired || pointerInside.current) return;
      if (
        s.page !== snap.page ||
        s.terminalActiveTabId !== snap.tab ||
        (s.selectProjectReq !== snap.project && s.selectProjectReq !== null)
      ) {
        fired = true;
        onCloseRef.current();
      }
    });
  }, [closing]);

  // Esc / 点到外面（菜单与触发区除外）收
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !busy()) {
        e.preventDefault();
        onCloseRef.current();
        returnFocus.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || busy() || ref.current?.contains(t)) return;
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
      data-shown={entered && !closing ? "true" : undefined}
      aria-hidden={closing || undefined}
      onMouseEnter={() => {
        pointerInside.current = true;
        clearTimer();
      }}
      onMouseLeave={() => {
        pointerInside.current = false;
        closeLater();
      }}
      className="ccode-rail-peek ccode-float-surface absolute bottom-[5px] top-0 z-30 flex min-h-0 flex-col overflow-hidden rounded-lg border border-field pt-2"
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
