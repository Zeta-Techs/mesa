import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 聊天层实时预览的匀速显示（2026-10-22，tests/text-reveal.test.ts）。
 *
 * 预览一块一块到：读屏 400ms 节流读一次，旁路 150ms 推一次快照，每块装着这段时间里模型写出的全部字，
 * 多少差一个数量级——到一块贴一块，看着就是一顿一顿地跳。做法借 Paseo（Apache-2.0，`.reference/paseo`
 * docs/agent-stream-performance.md）：到达只改「目标」，每帧放出积压量的一部分（与积压成正比，至少一个字），
 * 来一大块就追得快，但不跳。
 * - 第一次见到的文字整段显示，只有在原文后面接着长的部分才匀速放（预览被会话文件追上、换了一段，都当新文字）；
 * - 不在生成了就一次放完，不留尾巴；
 * - 只节流显示：上游的预览原文不动，复制、贴底按显示出来的那一截算。
 */

/** 积压按这个时间常数放完。到达间隔 150–400ms：太短会在两块之间停住，太长一轮结束前追不上（结束时一次放完） */
export const REVEAL_HORIZON_MS = 220;
/** 一帧的时长按这个封顶：后台标签、主线程卡住之后回来不一下子跳一大截 */
const MAX_FRAME_MS = 250;
/** 页面不画帧（窗口藏起来）时的兜底节拍：rAF 不来也要往前走 */
const FALLBACK_TICK_MS = 120;

/** 这一帧放出几个字（UTF-16 单元）：积压 × 时长 / 时间常数，至少 1，至多积压 */
export function revealStep(backlog: number, elapsedMs: number, horizonMs = REVEAL_HORIZON_MS): number {
  if (backlog <= 0) return 0;
  if (horizonMs <= 0) return backlog;
  const dt = Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS);
  if (dt <= 0) return 0;
  return Math.min(backlog, Math.max(1, Math.ceil((backlog * dt) / horizonMs)));
}

const JOINERS = /[\u200d\ufe0e\ufe0f\u20e3]|\p{M}/u;

/** 切口往后挪到能安全切开的地方：不切开代理对、组合附加符、零宽连接的表情序列 */
export function safeCut(text: string, at: number): number {
  let i = Math.max(0, Math.min(at, text.length));
  while (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    const prev = text.charCodeAt(i - 1);
    if (code >= 0xdc00 && code <= 0xdfff) {
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i) ?? code);
    if (JOINERS.test(ch) || prev === 0x200d) {
      i += ch.length;
      continue;
    }
    break;
  }
  return i;
}

/**
 * 目标换了以后，已显示的长度该是多少：新目标接着旧的显示内容往后长 → 保持（剩下的匀速放）；
 * 否则（第一次见、被会话文件追上换了一段、读屏重排）整段显示
 */
export function shownAfterRetarget(prevTarget: string, shown: number, next: string, active: boolean): number {
  if (!active) return next.length;
  const kept = prevTarget.slice(0, shown);
  return kept.length > 0 && next.startsWith(kept) ? kept.length : next.length;
}

/** 匀速显示 target；active = 还在生成（不在就一次放完） */
export function useRevealedText(target: string, active: boolean): string {
  const [shown, setShown] = useState(target.length);
  const ref = useRef({ target, shown: target.length });
  // 目标变了：先在绘制前定好已显示的长度（整段新文字这一帧就完整出来，不先闪一下空）
  useLayoutEffect(() => {
    const cur = ref.current;
    if (cur.target === target && (active || cur.shown === target.length)) return;
    const next = shownAfterRetarget(cur.target, cur.shown, target, active);
    ref.current = { target, shown: next };
    setShown(next);
  }, [target, active]);
  useEffect(() => {
    if (!active || shown >= target.length) return;
    let raf = 0;
    let timer = 0;
    let last = performance.now();
    // 一帧一放：放了字就交给下一次渲染重挂（依赖里有 shown），这一帧没放出字就自己再约一帧
    const schedule = () => {
      // 没有 rAF 的环境（测试用的 jsdom）只走兜底节拍
      raf = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(tick) : 0;
      timer = window.setTimeout(tick, FALLBACK_TICK_MS);
    };
    const cancel = () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    function tick() {
      cancel();
      const now = performance.now();
      const cur = ref.current;
      const step = revealStep(cur.target.length - cur.shown, now - last);
      last = now;
      if (step <= 0) {
        schedule();
        return;
      }
      const next = safeCut(cur.target, cur.shown + step);
      ref.current = { target: cur.target, shown: next };
      setShown(next);
    }
    schedule();
    return cancel;
  }, [active, shown, target]);
  return target.slice(0, Math.min(shown, target.length));
}
