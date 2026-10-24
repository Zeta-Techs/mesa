import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 弹层退场动效（apple-motion 手感批 2026-10-12）。
 * 约束见 docs/conventions/design-system.md「动效口径」：
 * - 退场沿入场路径逆向、时长对称（emil §7 空间一致性）；
 * - commit 动作（选中命令/菜单项）不走这里——立即执行，反馈由动作本身给（§1 响应优先）；
 * - reduced-motion 下时长取 0：跳过延迟直接卸载，不留静态残影挡视线。
 */

/** 退场基础时长（ms）：与入场 ccode-pop 150ms 对称 */
export const EXIT_ANIM_MS = 150;

/** 纯逻辑：reduced-motion 时退场时长取 0（立即卸载） */
export function exitDurationMs(
  reducedMotion: boolean,
  base = EXIT_ANIM_MS,
): number {
  return reducedMotion ? 0 : base;
}

export interface ExitRenderState {
  render: boolean;
  exiting: boolean;
}

/** 纯逻辑：由上一渲染态与 open 推导下一渲染态（useExitRender 与单测共用）
 *  open=true 恒满挂载；关闭时 dur<=0 立即卸载，否则保持挂载进入 exiting。 */
export function nextExitRenderState(
  prev: ExitRenderState,
  open: boolean,
  durMs: number,
): ExitRenderState {
  if (open) return { render: true, exiting: false };
  if (durMs <= 0) return { render: false, exiting: false };
  return { render: prev.render, exiting: prev.render };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 折叠区展开 / 收起时长（ms）：同侧栏收起 200ms，UI 反馈都在 200ms 内 */
export const COLLAPSE_MS = 200;

/**
 * 折叠区的阶段（PageFrame `Collapse`）：closed 不挂载；pre 刚挂上、行轨还在 0fr；opening / closing 过渡中，内容竖向裁切；
 * open 停稳后不再裁切（悬停底、焦点环不被切掉）
 */
export type CollapsePhase = "closed" | "pre" | "opening" | "open" | "closing";

/** 纯逻辑：open 翻转时的下一阶段。收起途中重开直接接着展开；reduced-motion 下收起立即卸载 */
export function nextCollapsePhase(phase: CollapsePhase, open: boolean, reducedMotion: boolean): CollapsePhase {
  if (open) return phase === "closed" ? "pre" : phase === "closing" ? "opening" : phase;
  if (phase === "closed" || phase === "closing") return phase;
  return reducedMotion ? "closed" : "closing";
}

/** 过渡跑完后落到的阶段；其余阶段不计时 */
export function settledCollapsePhase(phase: CollapsePhase): CollapsePhase | null {
  return phase === "opening" ? "open" : phase === "closing" ? "closed" : null;
}

/** 自带 open prop 的弹层壳（Modal/Sheet/MenuSelect/项目设置抽屉…）用：
 *  open→false 后保持渲染一小段时间（exiting 供退场样式 ccode-exiting），
 *  退场未完又重开则取消卸载。焦点恢复/滚动解锁不在此管——
 *  仍由调用方 [open] effect 的清理在关闭瞬间完成，退场只是视觉延续。
 *  closeNow 供 commit 路径（选中菜单项）用：跳过退场立即卸载（macOS 菜单
 *  选中即消失；反馈由动作本身给，emil §1）。 */
export function useExitRender(
  open: boolean,
  ms = EXIT_ANIM_MS,
): { render: boolean; exiting: boolean; closeNow: () => void } {
  const [render, setRender] = useState(open);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<number | null>(null);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (prevOpenRef.current === open) return;
    prevOpenRef.current = open;
    const next = nextExitRenderState(
      { render, exiting },
      open,
      exitDurationMs(prefersReducedMotion(), ms),
    );
    if (next.render === render && next.exiting === exiting) return;
    setRender(next.render);
    setExiting(next.exiting);
    if (next.exiting) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setExiting(false);
        setRender(false);
      }, exitDurationMs(prefersReducedMotion(), ms));
    } else if (timerRef.current !== null) {
      // 退场途中重开：取消卸载计时
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // render/exiting 只在 open 翻转分支读快照；后续重跑都会被 prevOpen 守卫挡住
  }, [open, ms, render, exiting]);

  // 卸载兜底：清掉可能残留的计时器
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // commit 即时关闭：清计时器并直接卸载（open 随后翻 false 时走「未挂载」分支，无残影）
  const closeNow = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setExiting(false);
    setRender(false);
  }, []);

  return { render, exiting: exiting && !open, closeNow };
}

/** 父级挂载控制的弹层（CommandPalette/ContextMenu/随手聊历史…）用：
 *  把「纯 dismiss」（Esc/遮罩/点外）包成先播退场、ms 后才调 onClose——父 API 不变。
 *  与 useExitRender 的差别：本钩子不控制挂载（父级仍在 onClose 后才卸载），
 *  只负责推迟 onClose 并给出 exiting 标记。重复 dismiss 是 no-op。 */
export function useAnimatedDismiss(
  onClose: () => void,
  ms = EXIT_ANIM_MS,
): { dismiss: () => void; exiting: boolean } {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const dismiss = useCallback(() => {
    if (timerRef.current !== null) return; // 已在退场
    const dur = exitDurationMs(prefersReducedMotion(), ms);
    if (dur <= 0) {
      onCloseRef.current();
      return;
    }
    setExiting(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onCloseRef.current();
    }, dur);
  }, [ms]);

  return { dismiss, exiting };
}
