import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

/** ai_distill_skill 的返回（SKILL.md frontmatter name/description + 正文规则清单） */
interface SkillDraftDto {
  name: string;
  description: string;
  content: string;
}

/** 「✦ 沉淀为技能…」：把当前选段交给 AI 提炼成技能草稿 → 跳技能页新建 modal 预填。
 *  低频动作，只作 ⋯ 菜单项（返回 FloatBarOverflow 的一项），不占浮动条主位；失败经 onHint 行内提示。 */
export function useDistillSkill(onHint: (msg: string) => void) {
  const setSkillDraftReq = useAppStore((s) => s.setSkillDraftReq);
  const setPage = useAppStore((s) => s.setPage);
  const [distilling, setDistilling] = useState(false);

  async function distill() {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected || distilling) return;
    setDistilling(true);
    try {
      const draft = await invoke<SkillDraftDto>("ai_distill_skill", {
        excerpt: selected,
      });
      setSkillDraftReq(draft);
      setPage("skills");
      // 清选区让浮动条随 selectionchange 收起（同其余按钮的收尾）
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      onHint(`提炼技能草稿失败：${e}`);
    } finally {
      setDistilling(false);
    }
  }

  return {
    label: distilling ? "提炼中…" : "✦ 沉淀为技能…",
    run: () => void distill(),
  };
}

/** 浮动条按钮（与对话选区小条 ChatSelectionBar 同一套：一块浮层里平铺，按钮不再各带边框）。
 *  一条里只给一个 FLOAT_BTN_PRIMARY（蓝底主钮），其余用 FLOAT_BTN。 */
export const FLOAT_BTN =
  "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1";
export const FLOAT_BTN_PRIMARY =
  "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md bg-cta px-2.5 text-xs text-cta-text hover:brightness-110";

/** 浮动条 ⋯ 溢出菜单（低频动作收在这里，主条保持紧凑）：
 *  开关状态随浮动条卸载自动复位（选区收起即关，不会在下次选区时残留展开） */
export function FloatBarOverflow({
  items,
}: {
  items: readonly { label: string; run: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <span className="relative">
      <button
        type="button"
        // preventDefault 保住选区，click 时才读文字
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-xs text-l3 hover:bg-hover hover:text-l1"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 flex flex-col rounded-md border border-hairline ccode-float-surface p-1">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className="whitespace-nowrap rounded-sm px-2 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * 选区浮动动作条（PDF「◈ 问 AI」与 md 阅读「◈ 讨论/改写此段」共用）：
 * 容器内选中文字 → 跟随选区末端下方显示按钮条；失选/收起即消失。
 * 按钮由调用方作为 children 渲染，须用 onMouseDown preventDefault 保住选区，
 * click 时再经 window.getSelection() 读取选段文本。
 */
export default function SelectionFloatBar({
  containerRef,
  withinSelector,
  reserveWidth = 170,
  children,
}: {
  /** 相对定位的滚动容器；选区锚点必须落在其中，按钮相对它绝对定位 */
  containerRef: RefObject<HTMLElement | null>;
  /** 选区锚点还必须命中的后代选择器（PDF 的 [data-page-num]、md 的 .md-body），
      防止终端等其他区域的选区误触发本条 */
  withinSelector: string;
  /** 右缘预留宽度（约等于按钮条总宽），避免溢出容器右缘 */
  reserveWidth?: number;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // 选区监听：容器内选中文字 → 跟随选区末端定位；失选/收起即隐藏。
  // 点击按钮后调用方 removeAllRanges 清选区，selectionchange 会自然把本条收掉
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const scroll = containerRef.current;
      if (!sel || sel.isCollapsed || !scroll) {
        setPos(null);
        return;
      }
      const node = sel.anchorNode;
      const el =
        node?.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement;
      if (!el || !scroll.contains(el) || !el.closest(withinSelector)) {
        setPos(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const sr = scroll.getBoundingClientRect();
      setPos({
        x: Math.max(
          8,
          Math.min(
            r.right - sr.left + scroll.scrollLeft - 72,
            sr.width - reserveWidth,
          ),
        ),
        y: r.bottom - sr.top + scroll.scrollTop + 6,
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [containerRef, withinSelector, reserveWidth]);

  if (!pos) return null;
  return (
    <div
      style={{ left: pos.x, top: pos.y }}
      className="ccode-float-surface absolute z-10 flex items-center gap-0.5 rounded-lg border border-hairline p-0.5"
    >
      {children}
    </div>
  );
}
