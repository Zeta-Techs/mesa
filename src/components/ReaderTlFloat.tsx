import { useEffect, useRef, useState, type ComponentProps } from "react";
import ReaderTranslatePanel from "./ReaderTranslatePanel";
import {
  clampReaderTlBall,
  loadReaderTlBall,
  readerTlBallOffset,
  saveReaderTlBall,
  type ReaderPdfBounds,
} from "../reader";

type PanelProps = Omit<
  ComponentProps<typeof ReaderTranslatePanel>,
  "heightPct" | "floatAnchor" | "floatBounds" | "onClose"
>;

/**
 * 译文悬浮球（钉住档与「右栏收起」兜底档的载体），挂在覆盖层根（fixed inset-0），
 * 坐标域是 PDF 栏（bounds 换算；2026-10-23 用户：球脱出了 PDF、压在右栏上——
 * 2026-10-14 曾放开成整窗，球能拖到笔记栏/对话栏上面，译文与原文对不上）。
 * 仍挂覆盖层根而不挂进 PDF 栏：拖动不被栏内滚动/裁剪挡住。一颗可拖动的「译」球
 * （ccode-float-surface 圆钮），点球在球旁展开译文卡（× 或再点收起回球）；
 * 拖球换位，松手记 localStorage（窗口百分比坐标，换宽高不失位）。
 * 位移 <4px 视为点击；新翻译落地/失败由 openTick 递进信号触发自动展开
 * （译完即见，不用先摸球）；用户在途翻译期间手动收球则压掉下一次自动展开。
 * 位置状态留在本组件——拖动逐帧 setState 不惊动 ReaderOverlay 整树
 * （PDF 连续视图不跟着重渲）。
 */
export default function ReaderTlFloat({
  panelProps,
  hasContent,
  openTick,
  startOpen,
  bounds,
}: {
  /** 译文卡除摆位外的全部 props（ReaderOverlay 的 tlPanelProps） */
  panelProps: PanelProps;
  /** 有译文/在途翻译才出球（空节点不出现） */
  hasContent: boolean;
  /** 悬浮会话内「该展开了」信号：递进即展开（新翻译落地/失败、在途开始） */
  openTick: number;
  /** 挂载即展开（从看得见的卡点「钉住」的接续：卡搬家到球旁，不是缩成球） */
  startOpen?: boolean;
  /** PDF 栏离覆盖层四边的 px：球和卡都只在 PDF 栏里，不盖笔记栏/右栏/顶栏 */
  bounds?: ReaderPdfBounds;
}) {
  const [pos, setPos] = useState(() => loadReaderTlBall());
  const posRef = useRef(pos);
  posRef.current = pos;
  const [open, setOpen] = useState(Boolean(startOpen));
  const ballRef = useRef<HTMLButtonElement>(null);
  // openTick 只认「递进」不认存量：记下挂载时的计数，之后变化才是新信号
  // （StrictMode 双挂载 ref 保留：记值式哨兵不受 setup→cleanup→setup 影响）
  const mountTickRef = useRef<number | null>(null);
  // 在途翻译期间用户手动收球：压掉下一次自动展开（刚合上别又被顶开）
  const suppressNextTickRef = useRef(false);

  useEffect(() => {
    if (mountTickRef.current === null) {
      mountTickRef.current = openTick;
      return;
    }
    if (openTick === mountTickRef.current) return;
    mountTickRef.current = openTick;
    if (suppressNextTickRef.current) {
      suppressNextTickRef.current = false;
      return;
    }
    setOpen(true);
  }, [openTick]);

  /** 球的拖/点：pointer 一套两用——位移 <4px 判点击（翻转展开），否则拖着走。
      坐标换算对最近的定位祖先（覆盖层根，即 offsetParent），松手才落 localStorage */
  function onBallPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const host = ballRef.current?.offsetParent as HTMLElement | null;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    // 拖动换算的基准是 PDF 栏宽高（百分比存的是球在 PDF 栏里的位置）
    const spanX = (bounds?.left ?? 0) + (bounds?.right ?? 0);
    const spanY = (bounds?.top ?? 0) + (bounds?.bottom ?? 0);
    const w = rect.width - spanX;
    const h = rect.height - spanY;
    if (w <= 0 || h <= 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const start = posRef.current;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && dx * dx + dy * dy < 16) return; // 4px 阈值：判点击还是拖动
      moved = true;
      setPos(
        clampReaderTlBall(
          start.xp + (dx / w) * 100,
          start.yp + (dy / h) * 100,
        ),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (moved) {
        const b = posRef.current;
        saveReaderTlBall(b.xp, b.yp);
      } else {
        // 在途翻译时手动合上：这次翻译的落地信号不自动顶开
        if (open && panelProps.pending) suppressNextTickRef.current = true;
        setOpen((v) => !v);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // PDF 栏边界量到之前不出球：首帧按整窗算会先落在别的栏上再跳回来
  if (!hasContent || !bounds) return null;

  return (
    <>
      <button
        ref={ballRef}
        type="button"
        aria-label={open ? "收起译文卡" : "展开译文卡"}
        aria-expanded={open}
        title="点击展开/收起译文；拖着换位置"
        onPointerDown={onBallPointerDown}
        // 键盘可达性：pointer 路径吃掉了鼠标点击，Enter/Space 走 onClick（detail=0）
        onClick={(e) => {
          if (e.detail === 0) setOpen((v) => !v);
        }}
        // 位置可贴 PDF 栏边：存档百分比按球半径（18px = size-9 的一半）兜在 PDF 栏内
        style={{
          left: readerTlBallOffset(
            pos.xp,
            bounds?.left ?? 0,
            (bounds?.left ?? 0) + (bounds?.right ?? 0),
          ),
          top: readerTlBallOffset(
            pos.yp,
            bounds?.top ?? 0,
            (bounds?.top ?? 0) + (bounds?.bottom ?? 0),
          ),
        }}
        className="ccode-float-surface absolute z-30 flex size-9 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none items-center justify-center rounded-full border border-field text-sm font-medium text-l2 hover:text-l1 active:cursor-grabbing"
      >
        译
      </button>
      {open && (
        <ReaderTranslatePanel
          {...panelProps}
          heightPct={null}
          floatAnchor={pos}
          floatBounds={bounds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
