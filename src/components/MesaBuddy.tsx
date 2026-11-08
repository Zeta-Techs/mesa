import { useEffect, useState } from "react";
import sheetUrl from "../assets/buddy/xiaozhuo.webp";
import { BUDDY_CELL, BUDDY_COLS, BUDDY_ROWS, buddyClip, buddyRow, type BuddyPose, type BuddyProp } from "../buddy-sprite";

export type { BuddyPose, BuddyProp };

/**
 * 项目助手的卡通形象「小桌」（原创：Mesa 是西班牙语「桌子」，项目助手是一张活过来的小工作台——桌面像顶帽子，桌裙是脸，
 * 桌上一摞文献和一块琥珀光标）。
 * 2026-11-09 用户：「没有 Codex 的宠物生动」，拍板「用出图模型孵一张精灵图」——由矢量拼图改成逐帧动画：
 * 借 Codex hatch-pet 的做法（一张基准图定长相，每个状态一行动作条以基准图为参考生成，切帧、统一基线、拼图），
 * 不做 16 个朝向（小桌只在面板里，不在桌面上跟鼠标走）。精灵图 `src/assets/buddy/xiaozhuo.webp`，每格 224px、8 列，
 * 行与帧时长在 buddy-sprite.ts；怎么重孵见 docs/design-project-assistant.md §11。
 * 深浅主题同一张：外圈烤了一道米白贴纸边，深底上墨线和脚不会隐掉。减弱动态效果时停在第一帧。
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
  // 点一下大图会蹦一下（只在站着时）
  const [poke, setPoke] = useState(0);
  const playing: BuddyPose = poke && pose === "idle" ? "happy" : pose;
  // 挥手 / 蹦完回到站着：记下是哪个姿势放完了，姿势一换自然作废
  const key = `${playing}:${prop}:${poke}`;
  const [restedFor, setRestedFor] = useState("");
  // 姿势换过一轮再回来（第二次答完又是 happy）要能再放一遍
  useEffect(() => setRestedFor(""), [pose, prop]);
  const row = restedFor === key ? buddyRow("idle", prop) : buddyRow(playing, prop);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    let loops = 0;
    let timer = 0;
    const tick = () => {
      timer = window.setTimeout(() => {
        i += 1;
        if (i >= row.durations.length) {
          loops += 1;
          if (row.repeat !== null && loops >= row.repeat) {
            if (row.after === "hold") setFrame(row.hold);
            else if (poke) setPoke(0);
            else setRestedFor(key);
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
    // 换了行就从头放（row 由 key 与 restedFor 决定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.index, key]);

  const pokeable = size > 40 && pose === "idle";
  const clip = buddyClip(size);
  const k = clip.height / clip.h; // 屏幕像素 / 精灵图像素
  return (
    <div
      className={`mesa-buddy shrink-0 ${className}`}
      data-pose={playing}
      aria-hidden="true"
      onClick={pokeable ? () => setPoke((n) => n + 1) : undefined}
      style={{
        cursor: pokeable ? "pointer" : undefined,
        width: clip.width,
        height: clip.height,
        backgroundImage: `url(${sheetUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${BUDDY_COLS * BUDDY_CELL * k}px ${BUDDY_ROWS * BUDDY_CELL * k}px`,
        backgroundPosition: `${-(frame * BUDDY_CELL + clip.x) * k}px ${-(row.index * BUDDY_CELL + clip.y) * k}px`,
      }}
    />
  );
}
