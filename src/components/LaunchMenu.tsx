import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { placeDownMenu, type DownMenuBox } from "../launch-menu";
import { useExitRender } from "../exit-animation";

export interface LaunchMenuOption {
  value: string;
  label: string;
  /** 非空时在该项上方画分组标题；连续同组只画一次 */
  group?: string;
  disabled?: boolean;
  /** 行尾小灰字（如权限格的「本机设置」「没有这一档」） */
  hint?: string;
  /** warn = 风险项整行橙色（权限格的「完全访问」） */
  tone?: "warn";
  /** 悬停说明 */
  title?: string;
}

/** 锚点下沿的浮层盒子。关闭后保持 150ms 退场（exiting 供退场样式），box 持续指向
 *  最后一次实测位置（box state 不清空，退场期间不脱锚）；彻底关闭后为 null。 */
export function useDownMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  preferredWidth: number,
): {
  box: DownMenuBox | null;
  exiting: boolean;
  /** commit 路径（选中项）即时关闭，不播退场 */
  closeNow: () => void;
} {
  const [box, setBox] = useState<DownMenuBox | null>(null);
  const { render, exiting, closeNow } = useExitRender(open);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setBox(
        placeDownMenu(
          { left: rect.left, bottom: rect.bottom, width: rect.width },
          { width: window.innerWidth, height: window.innerHeight },
          preferredWidth,
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, preferredWidth]);

  return { box: render ? box : null, exiting, closeNow };
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else ref.current = node;
}

export function DownMenu({
  box,
  exiting = false,
  menuRef,
  labelledBy,
  onKeyDown,
  id,
  children,
}: {
  box: DownMenuBox | null;
  /** useDownMenu 的退场标记：面板播 ccode-pop-out 并停止交互 */
  exiting?: boolean;
  menuRef?: Ref<HTMLDivElement>;
  labelledBy?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  id?: string;
  children: ReactNode;
}) {
  if (!box || typeof document === "undefined") return null;
  return createPortal(
    <div
      id={id}
      ref={menuRef}
      role="listbox"
      aria-label={labelledBy}
      onKeyDown={onKeyDown}
      // 按下时别把焦点从启动栏输入框偷走，否则模型清单会在点选前收起
      onMouseDown={(event) => event.preventDefault()}
      style={{
        top: box.top,
        left: box.left,
        width: box.width,
        maxHeight: box.maxHeight,
      }}
      className={`ccode-anchor-topleft ccode-float-surface fixed z-50 overflow-auto rounded-md border border-field py-1${exiting ? " ccode-exiting" : ""}`}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 启动栏的 Agent / 配置菜单：触发器在分段条里，清单从按钮下沿向下展开。 */
export default function LaunchMenu({
  label,
  value,
  placeholder,
  options,
  emptyHint,
  disabled,
  open,
  onOpenChange,
  onChange,
  buttonRef,
  className,
  preferredWidth = 240,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: LaunchMenuOption[];
  emptyHint?: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
  preferredWidth?: number;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusedOnce = useRef(false);
  const { box, exiting, closeNow } = useDownMenu(open, btnRef, preferredWidth);
  const current = options.find((item) => item.value === value);

  useLayoutEffect(() => {
    if (!open) {
      focusedOnce.current = false;
      return;
    }
    if (!box || focusedOnce.current) return;
    const root = menuRef.current;
    if (!root) return;
    const selected = root.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]:not(:disabled)',
    );
    const first = root.querySelector<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    );
    (selected ?? first)?.focus();
    focusedOnce.current = true;
  }, [open, box]);

  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target))
        return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not(:disabled)',
      ),
    ];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  let lastGroup = "";

  return (
    <>
      <button
        type="button"
        ref={(node) => {
          btnRef.current = node;
          assignRef(buttonRef, node);
        }}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}，${current?.label ?? placeholder}`}
        title={`${label}：${current?.label ?? placeholder}`}
        className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-left ${className ?? ""}`}
        // 用按下而不是 click：焦点在终端里时，第一次 click 会先被失焦吃掉
        onMouseDown={(event) => {
          if (disabled) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(!open);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <span className={`min-w-0 flex-1 truncate ${current ? "" : "text-l4"}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-l4"
          aria-hidden="true"
        />
      </button>
      {box && (
        <DownMenu
          box={box}
          exiting={exiting}
          menuRef={menuRef}
          labelledBy={label}
          onKeyDown={onMenuKey}
        >
          <div className="px-2.5 pb-0.5 pt-1.5 text-xs text-l4">{label}</div>
          {options.length === 0 && (
            <div className="px-2.5 py-1.5 text-sm text-l4">
              {emptyHint ?? "没有可选项"}
            </div>
          )}
          {options.map((item) => {
              const showGroup = !!item.group && item.group !== lastGroup;
              lastGroup = item.group ?? "";
              const selected = item.value === value;
              return (
                <div key={item.value}>
                  {showGroup && (
                    <div className="px-2.5 pb-0.5 pt-1.5 text-xs text-l4">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={item.disabled}
                    title={item.title}
                    className={`flex h-8 w-full items-center gap-2 px-2.5 text-left text-sm disabled:opacity-40 ${
                      item.tone === "warn"
                        ? `text-warn-text ${selected ? "bg-hover" : "hover:bg-hover"}`
                        : selected
                          ? "bg-hover text-l1"
                          : "text-l2 hover:bg-hover hover:text-l1"
                    }`}
                    onClick={() => {
                      onChange(item.value);
                      closeNow();
                      onOpenChange(false);
                      btnRef.current?.focus();
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="shrink-0 text-micro text-l4">{item.hint}</span>
                    )}
                    {selected && (
                      <Check
                        size={14}
                        strokeWidth={1.8}
                        className="shrink-0 text-l3"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </div>
              );
            })}
        </DownMenu>
      )}
    </>
  );
}
