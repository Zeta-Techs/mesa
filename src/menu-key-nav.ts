import { useEffect, type RefObject } from "react";

/**
 * 小弹层的键盘操作（聊天输入框的 Agent·模型选择、模型·思考芯片、权限徽标共用，2026-10-17）：
 * 打开时焦点落到当前选中项（aria-checked / data-selected），没有就第一个可点项；
 * ↑↓ 在可点按钮间移动（Home / End 到头尾），回车 / 空格是按钮原生行为；
 * 焦点在输入框里时不接管方向键（模型栏底部的「其他模型」输入框要能正常移动光标）。
 * 关闭时焦点还给打开前的元素（多半是触发按钮），免得掉到 body 上。
 */
export function useMenuKeyNav(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  /** 弹层内换了一屏（如模型菜单进入「换 Agent / 配置」）时传入新值：重新把焦点落到当前项 */
  view?: string,
) {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () =>
      Array.from(root.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    const initial =
      root.querySelector<HTMLElement>(
        'button[aria-checked="true"]:not([disabled]), button[data-selected="true"]:not([disabled])',
      ) ?? items()[0];
    initial?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLButtonElement) || !root.contains(active)) return;
      const list = items();
      const at = list.indexOf(active);
      let next = -1;
      if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
      else if (e.key === "ArrowUp") next = at <= 0 ? list.length - 1 : at - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      if (next < 0) return;
      e.preventDefault();
      list[next]?.focus();
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref, open, view]);
}
