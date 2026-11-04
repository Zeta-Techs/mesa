import { isLightTheme } from "../themes";
import { useAppStore } from "../store";

export type BuddyPose = "idle" | "wave" | "think" | "happy" | "oops" | "sleep";
/** 桌上多放的一样东西，跟着时间换（buddy-time.ts）：早上一杯冒热气的咖啡，傍晚一盏亮着的小台灯 */
export type BuddyProp = "coffee" | "lamp" | null;

/**
 * 项目助手的卡通形象「小桌」（2026-11-04 用户：「像 Claude 的像素小人一样生动一点，当然不是像素风」）。
 * 原创角色：Mesa 是西班牙语的「桌子」、产品本身就是「工作台」——项目助手就是一张活过来的小工作台：
 * 桌面是头顶，桌裙上是脸，两条桌腿呼应 M 字标的两条腿，桌上放一摞文献和一块 M▁ 琥珀光标。
 * 平面、粗描边（全站零投影、零渐变），靠形状和动作出性格：
 * idle 轻轻晃、眨眼、光标闪；wave 挥手打招呼；think 抬眼托腮、头上冒三道光标；happy 举手蹦一下；oops 皱眉；
 * sleep 夜深了盘腿坐着睡、头上飘 z、桌上光标调暗（同日用户：「白天和夜深了也可以有不同表现，盘腿睡觉」）。
 * 动作在 App.css .mesa-buddy*，减弱动态效果时全部静止。
 */
export default function MesaBuddy({
  size = 32,
  pose = "idle",
  prop = null,
  className = "",
}: {
  size?: number;
  pose?: BuddyPose;
  prop?: BuddyProp;
  className?: string;
}) {
  const sleep = pose === "sleep";
  const light = isLightTheme(useAppStore((s) => s.settings?.theme));
  // 深色主题也用浅色那一套「米白身子 + 墨线」（2026-11-04 用户：浅色的可以、深色的再改）——
  // 深底上像一张贴纸最醒目；只把米白压暗一档免得刺眼，脚改暖灰（墨色的脚在深底上会消失）
  const ink = light ? "#2b2a30" : "#1c1b21"; // 描边与五官
  const body = light ? "#fbf8f1" : "#e8e1d2"; // 桌裙
  const top = light ? "#efe8da" : "#d6ccb8"; // 桌面
  const paper = light ? "#ffffff" : "#f4f0e7";
  const foot = light ? "#2b2a30" : "#8d8778";
  // 胳膊：浅色是墨线包一道米白；深色底上墨线隐进背景，里面那道加粗，胳膊才连得上身子
  const armIn = light ? 3.5 : 6;
  const amber = light ? "#e39a1c" : "#f5b83d";
  const sw = 3;
  const eyeY = pose === "think" ? 59 : 62;
  const lookX = pose === "think" ? 1.6 : 0;
  // 手臂：肩在桌裙两侧（26,62）/（94,62），按姿势换路径；手是一个小圆
  const arms: Record<BuddyPose, { l: [string, number, number]; r: [string, number, number] }> = {
    idle: { l: ["M26 64 Q17 70 18 79", 18, 79], r: ["M94 64 Q103 70 102 79", 102, 79] },
    wave: { l: ["M26 62 Q10 58 6 40", 6, 40], r: ["M94 64 Q103 70 102 79", 102, 79] },
    think: { l: ["M26 64 Q17 70 18 79", 18, 79], r: ["M94 66 Q92 82 76 80", 76, 80] },
    happy: { l: ["M26 60 Q8 56 5 36", 5, 36], r: ["M94 60 Q112 56 115 36", 115, 36] },
    oops: { l: ["M26 64 Q17 70 18 79", 18, 79], r: ["M94 64 Q103 70 102 79", 102, 79] },
    // 睡着：两手搭在盘起的腿上
    sleep: { l: ["M26 66 Q19 76 27 86", 27, 86], r: ["M94 66 Q101 76 93 86", 93, 86] },
  };
  const arm = arms[pose];
  // 抬起来的手臂（挥手 / 托腮 / 举手 / 抱头）画在桌子前面，垂着的画在后面
  const armsFront = pose !== "idle";
  const armsEl = (
    <g>
        <g className={pose === "wave" ? "mesa-buddy-wave" : undefined}>
          <path d={arm.l[0]} fill="none" stroke={ink} strokeWidth="9" />
          <path d={arm.l[0]} fill="none" stroke={body} strokeWidth={armIn} />
          <circle cx={arm.l[1]} cy={arm.l[2]} r="5" fill={body} stroke={ink} strokeWidth={sw} />
        </g>
        <path d={arm.r[0]} fill="none" stroke={ink} strokeWidth="9" />
        <path d={arm.r[0]} fill="none" stroke={body} strokeWidth={armIn} />
        <circle cx={arm.r[1]} cy={arm.r[2]} r="5" fill={body} stroke={ink} strokeWidth={sw} />
    </g>
  );
  // 盘腿（2026-11-04 用户：交叉两根长条「怪怪的」）：从正面看，两膝往外撇、两只脚心在正中并在一起；
  // 画在身子前面（坐着时腿在桌裙前），手搭在膝盖上
  const sleepLegs = (
    <>
            <path d="M56 99 Q42 104 27 95" fill="none" stroke={ink} strokeWidth="15" />
            <path d="M56 99 Q42 104 27 95" fill="none" stroke={body} strokeWidth={light ? 9 : 11} />
            <path d="M64 99 Q78 104 93 95" fill="none" stroke={ink} strokeWidth="15" />
            <path d="M64 99 Q78 104 93 95" fill="none" stroke={body} strokeWidth={light ? 9 : 11} />
            <ellipse cx="54.5" cy="102" rx="5" ry="6" fill={body} stroke={ink} strokeWidth="2.6" transform="rotate(-20 54.5 102)" />
            <ellipse cx="65.5" cy="102" rx="5" ry="6" fill={body} stroke={ink} strokeWidth="2.6" transform="rotate(20 65.5 102)" />
          </>
  );
  return (
    <svg
      // 小尺寸（≤40px，头像位）只取半身：桌面到桌裙，脸才看得清；腿和脚留给大图
      viewBox={size <= 40 ? "4 12 112 80" : "0 0 120 120"}
      width={size <= 40 ? size * 1.4 : size}
      height={size}
      className={`mesa-buddy shrink-0 overflow-visible ${className}`}
      data-pose={pose}
      aria-hidden="true"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className="mesa-buddy-body">
        {sleep ? null : (
          <>
            {/* 桌腿 + 小脚 */}
            <rect x="37" y="80" width="11" height="22" rx="5.5" fill={body} stroke={ink} strokeWidth={sw} />
            <rect x="72" y="80" width="11" height="22" rx="5.5" fill={body} stroke={ink} strokeWidth={sw} />
            <ellipse cx="41" cy="104" rx="9" ry="4.5" fill={foot} />
            <ellipse cx="79" cy="104" rx="9" ry="4.5" fill={foot} />
          </>
        )}
        <g transform={sleep ? "translate(0 6)" : undefined}>
        {!armsFront && armsEl}
        {/* 桌裙（脸） */}
        <rect x="24" y="44" width="72" height="40" rx="15" fill={body} stroke={ink} strokeWidth={sw} />
        {/* 桌面 */}
        <rect x="11" y="33" width="98" height="15" rx="7.5" fill={top} stroke={ink} strokeWidth={sw} />
        {/* 桌上：一摞文献 + M▁ 光标 */}
        <rect x="22" y="25" width="20" height="8" rx="2" fill={paper} stroke={ink} strokeWidth="2.5" />
        <rect x="25" y="19" width="16" height="7" rx="2" fill={paper} stroke={ink} strokeWidth="2.5" />
        <rect
          className={sleep ? undefined : "mesa-buddy-cursor"}
          x="72"
          y="24"
          width="20"
          height="9"
          rx="2.5"
          fill={amber}
          opacity={sleep ? 0.35 : 1}
          stroke={ink}
          strokeWidth="2.5"
        />
        {prop === "coffee" && (
          <g>
            <path className="mesa-buddy-steam" d="M52 15 Q49 11 52 7 Q55 3 52 -1" fill="none" stroke={foot} strokeWidth="2" opacity="0.7" />
            <path className="mesa-buddy-steam" style={{ animationDelay: "0.6s" }} d="M58 15 Q55 11 58 7" fill="none" stroke={foot} strokeWidth="2" opacity="0.7" />
            <path d="M62 23 Q68 23 68 27.5 Q68 32 62 31" fill="none" stroke={ink} strokeWidth="2.5" />
            <rect x="48" y="18" width="15" height="15" rx="3.5" fill={paper} stroke={ink} strokeWidth="2.5" />
            <rect x="50.5" y="21" width="10" height="3" rx="1.2" fill={amber} />
          </g>
        )}
        {prop === "lamp" && (
          <g>
            <circle cx="58" cy="17" r="13" fill={amber} opacity={light ? 0.16 : 0.24} />
            <path d="M55 33 L55 18" stroke={ink} strokeWidth="2.5" />
            <rect x="49" y="31" width="12" height="3" rx="1.5" fill={ink} />
            <path d="M48 18 L54 7 L64 9 L64 20 Z" fill={amber} stroke={ink} strokeWidth="2.5" />
          </g>
        )}
        {/* 腮红 */}
        <ellipse cx="38" cy="71" rx="4.5" ry="2.6" fill={amber} opacity="0.55" />
        <ellipse cx="82" cy="71" rx="4.5" ry="2.6" fill={amber} opacity="0.55" />
        {/* 眼睛 */}
        {pose === "happy" ? (
          <>
            <path d="M43 64 Q48 57 53 64" fill="none" stroke={ink} strokeWidth="3.4" />
            <path d="M67 64 Q72 57 77 64" fill="none" stroke={ink} strokeWidth="3.4" />
          </>
        ) : sleep ? (
          <>
            <path d="M43 62 Q48 67 53 62" fill="none" stroke={ink} strokeWidth="3.2" />
            <path d="M67 62 Q72 67 77 62" fill="none" stroke={ink} strokeWidth="3.2" />
          </>
        ) : (
          <g className="mesa-buddy-eyes">
            <ellipse cx="48" cy={eyeY} rx="4.6" ry="5.8" fill={ink} />
            <ellipse cx="72" cy={eyeY} rx="4.6" ry="5.8" fill={ink} />
            <circle cx={49.6 + lookX} cy={eyeY - 2.2} r="1.7" fill={body} />
            <circle cx={73.6 + lookX} cy={eyeY - 2.2} r="1.7" fill={body} />
          </g>
        )}
        {pose === "oops" && (
          <>
            <path d="M42 54.5 L52 51.5" stroke={ink} strokeWidth="2.8" />
            <path d="M78 54.5 L68 51.5" stroke={ink} strokeWidth="2.8" />
          </>
        )}
        {/* 嘴 */}
        {pose === "happy" ? (
          <path d="M53 70 Q60 80 67 70 Z" fill={ink} stroke={ink} strokeWidth="2" />
        ) : pose === "think" ? (
          <circle cx="62" cy="74" r="2.4" fill="none" stroke={ink} strokeWidth="2.6" />
        ) : pose === "oops" ? (
          <path d="M53 75 Q56.5 71.5 60 75 Q63.5 78.5 67 75" fill="none" stroke={ink} strokeWidth="2.6" />
        ) : sleep ? (
          <ellipse cx="60" cy="73" rx="2.6" ry="2" fill={ink} />
        ) : (
          <path d="M54 71 Q60 76.5 66 71" fill="none" stroke={ink} strokeWidth="2.8" />
        )}
        {sleep && <g transform="translate(0 -6)">{sleepLegs}</g>}
        {armsFront && armsEl}
        {pose === "oops" && (
          <path d="M98 50 Q95 56 98 58 Q101 56 98 50 Z" fill="#8fc3ec" stroke={ink} strokeWidth="2" />
        )}
        </g>
      </g>
      {/* 睡着：头上飘三个 z，一个比一个大 */}
      {sleep && (
        <g fill="none" stroke={light ? ink : body} strokeWidth="2.4">
          <path className="mesa-buddy-z" style={{ animationDelay: "0s" }} d="M98 12 h6 l-6 7 h6" />
          <path className="mesa-buddy-z" style={{ animationDelay: "0.8s" }} d="M106 -1 h8 l-8 9 h8" />
          <path className="mesa-buddy-z" style={{ animationDelay: "1.6s" }} d="M114 -16 h10 l-10 11 h10" />
        </g>
      )}
      {/* 在想：头上冒三道光标 */}
      {pose === "think" && (
        <g>
          <rect className="mesa-buddy-dot" style={{ animationDelay: "0s" }} x="96" y="20" width="8" height="4" rx="1.5" fill={amber} />
          <rect className="mesa-buddy-dot" style={{ animationDelay: "0.25s" }} x="103" y="11" width="9" height="4" rx="1.5" fill={amber} />
          <rect className="mesa-buddy-dot" style={{ animationDelay: "0.5s" }} x="110" y="2" width="10" height="4" rx="1.5" fill={amber} />
        </g>
      )}
    </svg>
  );
}

/**
 * 「小桌」的线条小图标（项目助手入口按钮用，2026-11-04 用户：救生圈换掉）：和 Lucide 图标同一种笔触（24 格、圆头、currentColor），
 * 桌面一横 + 桌裙一张脸 + 两条桌腿，按钮里一眼认得出是项目助手。可当 LucideIcon 传（size / strokeWidth / className）
 */
export function MesaBuddyIcon({
  size = 14,
  strokeWidth = 1.8,
  className = "",
  ...rest
}: {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.5 6.5h19" />
      <rect x="5" y="6.5" width="14" height="10.5" rx="3.5" />
      <path d="M8.5 17v3.5M15.5 17v3.5" />
      <circle cx="9.6" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.4" cy="11" r="1.1" fill="currentColor" stroke="none" />
      <path d="M10.2 13.6c1 .9 2.6 .9 3.6 0" />
    </svg>
  );
}
