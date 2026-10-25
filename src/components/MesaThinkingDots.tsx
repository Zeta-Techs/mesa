import { useEffect, useRef, useState } from "react";
import { assignSlots, FORMATIONS, pickNextFormation, type Slot } from "../jump-formations";

/** 每个队形停多久再换（含换队滑动的 1.1s，见 App.css .ccode-jump-dots） */
const FORMATION_MS = 3200;

/**
 * 聊天「回到最新」浮钮生成中的三枚琥珀光标（2026-10-26 用户：动画要有呼吸感、像在空间里变换，节奏慢一点、队形随机）。
 * 队形表与换队规则在 jump-formations.ts；位置 / 形状经 CSS 的 translate / scale 过渡滑过去，
 * 明暗与整组张缩的呼吸是 App.css 里的常驻关键帧。减弱动态效果时停在「一行」不换队。
 * 外层（ChatSurface）负责定位与悬停换 ↓，这里只画三枚光标
 */
export default function MesaThinkingDots({ className = "" }: { className?: string }) {
  const [slots, setSlots] = useState<Slot[]>(() => [...FORMATIONS[0].slots]);
  const formationRef = useRef(FORMATIONS[0].id);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => {
      const next = pickNextFormation(formationRef.current, Math.random());
      formationRef.current = next.id;
      setSlots(assignSlots(slotsRef.current, next.slots));
    }, FORMATION_MS);
    return () => window.clearInterval(t);
  }, []);

  return (
    <span aria-hidden="true" className={`ccode-jump-dots ${className}`}>
      {slots.map((s, i) => (
        <span
          key={i}
          data-shape={s.shape}
          style={{ translate: `${s.x}px ${s.y}px` }}
        />
      ))}
    </span>
  );
}
