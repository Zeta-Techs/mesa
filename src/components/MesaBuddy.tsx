import { useEffect, useId, useState } from "react";
import {
  CAT_COLS,
  CAT_FRAMES,
  CAT_ROWS,
  buddyRow,
  calmPause,
  normalizeBuddyStyle,
  type BuddyMotion,
  type BuddyPose,
  type BuddyProp,
  type BuddyStyle,
} from "../buddy-sprite";
import { useAppStore } from "../store";

export type { BuddyMotion, BuddyPose, BuddyProp, BuddyStyle };

const CAT_PALETTE: Record<string, string> = {
  M: "var(--ccode-cat-body)",
  A: "var(--color-mesa-amber)",
  H: "var(--ccode-buddy-amber-hi)",
  B: "var(--ccode-buddy-amber-dim)",
  E: "var(--color-err-text)",
};

/**
 * 项目助手与桌宠的统一形象组件（2026-11-20 起为双纯矢量方案，设置页一键切换）：
 * - cat（默认）：13×10 极简双色像素黑猫（纯色猫身 + 品牌琥珀眼），无白贴纸边、不沉底；
 * - monolith：无底座精工仪（OLED 黑屏 + 琥珀光标眼神，干活态仅底槽单轨扫描，安静克制）。
 * motion 三档：lively（面板 / 桌宠活泼）| calm（桌宠安静档）| still（静止 / 减弱动态效果）。
 */
export default function MesaBuddy({
  size = 32,
  pose = "idle",
  prop = null,
  className = "",
  motion = "lively",
  pokeable: allowPoke = true,
  buddyStyle,
}: {
  size?: number;
  pose?: BuddyPose;
  prop?: BuddyProp;
  className?: string;
  motion?: BuddyMotion;
  /** 点大图蹦一下（桌宠上点它是开卡片，关掉） */
  pokeable?: boolean;
  /** 显式指定形象（设置页双卡预览、独立桌宠窗口传值）；不传时跟随主窗口 store 设置 */
  buddyStyle?: BuddyStyle;
}) {
  const storeStyle = useAppStore((s) => s.settings?.buddyStyle);
  const style = normalizeBuddyStyle(buddyStyle ?? storeStyle);

  // 点一下大图会蹦一下（只在待机时）
  const [poke, setPoke] = useState(0);
  const playing: BuddyPose = poke && pose === "idle" ? "happy" : pose;
  const key = `${style}:${playing}:${prop}:${poke}`;
  const [restedFor, setRestedFor] = useState("");
  useEffect(() => setRestedFor(""), [style, pose, prop]);
  const effectivePose: BuddyPose = restedFor === key ? "idle" : playing;
  const row = buddyRow(effectivePose, prop);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (motion === "still") {
      setFrame(row.calmHold);
      return;
    }
    setFrame(0);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const repeat = motion === "calm" ? 1 : row.repeat;
    let i = 0;
    let loops = 0;
    let timer = 0;
    const tick = () => {
      timer = window.setTimeout(() => {
        i += 1;
        if (i >= row.durations.length) {
          loops += 1;
          if (repeat !== null && loops >= repeat) {
            if (row.after === "hold" && row.repeat !== null) setFrame(row.hold);
            else if (row.repeat !== null && poke) setPoke(0);
            else if (row.repeat !== null) setRestedFor(key);
            else {
              setFrame(row.calmHold);
              // 安静档：播完一遍停在说明状态的那帧，隔 35–50 秒再轻动一下
              timer = window.setTimeout(() => {
                i = 0;
                loops = 0;
                setFrame(0);
                tick();
              }, calmPause(Math.random()));
            }
            return;
          }
          i = 0;
        }
        setFrame(i);
        tick();
      }, row.durations[i]);
    };
    tick();
    return () => window.clearTimeout(timer);
    // row 按 key 唯一确定，不把对象引用放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, motion]);

  const pokeable = allowPoke && size >= 56 && pose === "idle";
  const visual =
    style === "monolith" ? (
      <MonolithSvg size={size} pose={effectivePose} motion={motion} />
    ) : (
      <PixelCatSvg size={size} pose={effectivePose} frame={frame} />
    );

  return (
    <span
      role="img"
      aria-label={style === "monolith" ? "项目助手 Monolith" : "项目助手桌角黑猫"}
      onClick={pokeable ? () => setPoke((n) => n + 1) : undefined}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 select-none items-center justify-center ${
        pokeable ? "cursor-pointer" : ""
      } ${className}`}
    >
      {visual}
    </span>
  );
}

function PixelCatSvg({
  size,
  pose,
  frame,
}: {
  size: number;
  pose: BuddyPose;
  frame: number;
}) {
  const frames = CAT_FRAMES[pose] ?? CAT_FRAMES.idle;
  const grid = frames[frame % frames.length];
  const height = Math.round((size * CAT_ROWS) / CAT_COLS);
  const rects: { x: number; y: number; fill: string }[] = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const fill = CAT_PALETTE[ch];
      if (fill) rects.push({ x, y, fill });
    }
  }
  return (
    <svg
      viewBox={`0 0 ${CAT_COLS} ${CAT_ROWS}`}
      width={size}
      height={height}
      fill="none"
      className="ccode-pixel-art block"
      aria-hidden="true"
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}

function MonolithSvg({
  size,
  pose,
  motion,
}: {
  size: number;
  pose: BuddyPose;
  motion: BuddyMotion;
}) {
  const uid = useId().replace(/:/g, "");
  const shellId = `ccode-mono-shell-${uid}`;
  const screenId = `ccode-mono-scr-${uid}`;
  const glowId = `ccode-mono-glow-${uid}`;
  const isErr = pose === "oops";
  const isSleep = pose === "sleep";
  const animated = motion !== "still";
  const accent = isErr ? "var(--color-err-text)" : "var(--color-mesa-amber)";
  const crisp = size <= 28;

  const wrapClass = !animated
    ? ""
    : pose === "wave"
      ? "ccode-mono-wave"
      : pose === "happy"
        ? "ccode-mono-happy"
        : pose === "wait"
          ? "ccode-mono-wait"
          : pose === "oops"
            ? "ccode-mono-oops"
            : "";

  return (
    <span
      data-motion={motion}
      className={`ccode-mono-root inline-flex items-center justify-center ${wrapClass}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 64 64" width={size} height={size} fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={shellId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ccode-mono-top)" />
            <stop offset="55%" stopColor="var(--ccode-mono-mid)" />
            <stop offset="100%" stopColor="var(--ccode-mono-bot)" />
          </linearGradient>
          <linearGradient id={screenId} x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0%" stopColor="var(--ccode-mono-screen-top)" />
            <stop offset="100%" stopColor="var(--ccode-mono-screen)" />
          </linearGradient>
          <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={crisp ? 0.5 : 1.7} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* 精工圆角机身（52×46） */}
        <rect
          x="6"
          y="9"
          width="52"
          height="46"
          rx="13.5"
          fill={`url(#${shellId})`}
          stroke="var(--ccode-mono-stroke)"
          strokeWidth="1.4"
        />
        <path d="M18 10.3 H46" stroke="#ffffff" strokeOpacity="0.28" strokeWidth="1" strokeLinecap="round" />
        {/* 内嵌 OLED 黑玻璃屏 */}
        <rect
          x="11"
          y="14"
          width="42"
          height="29"
          rx="8"
          fill={`url(#${screenId})`}
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="1"
        />
        <path d="M13.5 16 L28.5 16 L13.5 30 Z" fill="var(--ccode-mono-spec)" opacity="0.55" />

        {/* 屏内眼神：干活态上眼静止专注，仅底槽单轨扫描，绝不上下齐晃 */}
        {pose === "idle" && (
          <g className={animated ? "ccode-mono-look" : undefined}>
            <g className={animated ? "ccode-mono-blink" : undefined} filter={`url(#${glowId})`}>
              <rect x="19" y="25.5" width="9.5" height="3.2" rx="1.6" fill={accent} />
              <rect x="35.5" y="25.5" width="9.5" height="3.2" rx="1.6" fill={accent} />
            </g>
          </g>
        )}
        {pose === "wave" && (
          <g filter={`url(#${glowId})`}>
            <path d="M19.5 28.5 Q24 24.5 28.5 28.5" stroke={accent} strokeWidth="2.9" strokeLinecap="round" />
            <rect x="35.5" y="25" width="9.5" height="3.4" rx="1.7" fill={accent} />
          </g>
        )}
        {pose === "think" && (
          <>
            <g filter={`url(#${glowId})`}>
              <rect x="19.5" y="23.5" width="8.5" height="2.6" rx="1.3" fill={accent} />
              <rect x="36" y="23.5" width="8.5" height="2.6" rx="1.3" fill={accent} />
            </g>
            <rect x="19" y="32.5" width="26" height="1.8" rx="0.9" fill="#ffffff" opacity="0.14" />
            <g className={animated ? "ccode-mono-scan" : undefined}>
              <rect x="27" y="32.5" width="10" height="1.8" rx="0.9" fill={accent} />
            </g>
          </>
        )}
        {pose === "wait" && (
          <g filter={`url(#${glowId})`}>
            <rect x="19.5" y="23" width="9" height="4.2" rx="2" fill={accent} />
            <rect x="35.5" y="23" width="9" height="4.2" rx="2" fill={accent} />
            <circle cx="32" cy="33" r="1.8" fill={accent} className={animated ? "ccode-mono-breathe" : undefined} />
          </g>
        )}
        {pose === "happy" && (
          <g filter={`url(#${glowId})`}>
            <path d="M19 29 Q23.8 23.8 28.6 29" stroke={accent} strokeWidth="3" strokeLinecap="round" />
            <path d="M35.4 29 Q40.2 23.8 45 29" stroke={accent} strokeWidth="3" strokeLinecap="round" />
          </g>
        )}
        {pose === "oops" && (
          <g filter={`url(#${glowId})`}>
            <rect x="19.5" y="26" width="8.5" height="2.6" rx="1.3" fill={accent} />
            <path d="M36.5 23.8 L43.5 30.6 M43.5 23.8 L36.5 30.6" stroke={accent} strokeWidth="2.6" strokeLinecap="round" />
          </g>
        )}
        {pose === "sleep" && (
          <g className={animated ? "ccode-mono-sleep" : undefined}>
            <rect x="20" y="27.5" width="8.5" height="1.9" rx="0.95" fill={accent} />
            <rect x="35.5" y="27.5" width="8.5" height="1.9" rx="0.95" fill={accent} />
          </g>
        )}
        {(pose === "walkRight" || pose === "walkLeft") && (
          <g filter={`url(#${glowId})`}>
            <rect
              x={pose === "walkRight" ? 22 : 16}
              y="25.5"
              width="9"
              height="3.2"
              rx="1.6"
              fill={accent}
            />
            <rect
              x={pose === "walkRight" ? 38 : 32}
              y="25.5"
              width="9"
              height="3.2"
              rx="1.6"
              fill={accent}
            />
          </g>
        )}

        {/* 底部微铭文 M 与状态指示灯 */}
        <path
          d="M16 50.2V47.4H17.2L18.2 48.9L19.2 47.4H20.4V50.2H19.4V48.6L18.5 49.9H17.9L17 48.6V50.2H16Z"
          fill="var(--color-l4)"
          opacity="0.72"
        />
        <rect x="22" y="48.8" width="4" height="1.3" rx="0.65" fill="var(--color-l4)" opacity="0.38" />
        <circle
          cx="47.5"
          cy="49"
          r="1.6"
          fill={accent}
          opacity={isSleep ? 0.3 : 0.95}
          className={animated && (pose === "idle" || isSleep) ? "ccode-mono-breathe" : undefined}
        />
      </svg>
    </span>
  );
}
