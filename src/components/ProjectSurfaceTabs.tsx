import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, Clock3, Files, ListChecks } from "lucide-react";
import {
  projectTaskLabel,
  projectSurfaceTabsForMode,
  type ProjectSurfaceTab,
} from "../project-surface";
import { nextTabIndex, tabNavDelta, tabStopIndex } from "../tab-keys";
import type { ProjectDto } from "../types";

const TAB_ICONS = {
  tasks: ListChecks,
  schedules: Clock3,
  files: Files,
  agents: Bot,
} as const;

export default function ProjectSurfaceTabs({
  project,
  active,
  onChange,
  taskPanel,
  trailing,
  children,
}: {
  project: ProjectDto | null;
  active: ProjectSurfaceTab;
  onChange: (tab: ProjectSurfaceTab) => void;
  taskPanel?: ReactNode;
  /** 页签行右端（「＋ 新对话」：在这个项目里开一段对话） */
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  // hooks 必须在提前 return 之前——project 为空时也要照常调用
  const tabIds = project
    ? projectSurfaceTabsForMode(project.workMode)
    : ([] as readonly ProjectSurfaceTab[]);
  const selectedIndex = tabIds.indexOf(active);
  const [focusIndex, setFocusIndex] = useState(selectedIndex);
  const [scrolled, setScrolled] = useState(false);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // 当前选中项变化（含键盘切换、外部跳转）时，把游标收回到它身上
  useEffect(() => {
    if (selectedIndex >= 0) setFocusIndex(selectedIndex);
  }, [selectedIndex]);

  // 切页签或切项目时重置滚动遮罩态，避免首屏顶部被误虚化
  useEffect(() => {
    setScrolled(false);
  }, [active, project?.path]);

  useLayoutEffect(() => {
    if (!project || selectedIndex < 0) {
      setIndicator(null);
      return;
    }
    const measure = () => {
      const btn = buttons.current[selectedIndex];
      if (!btn || btn.offsetWidth <= 0) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    const btn = buttons.current[selectedIndex];
    if (!btn || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(btn);
    if (btn.parentElement) ro.observe(btn.parentElement);
    return () => ro.disconnect();
  }, [project, selectedIndex, tabIds.length]);

  if (!project) {
    return (
      <div
        data-project-main-scroll
        className="min-h-0 flex-1 overflow-auto pb-6"
      >
        {children}
      </div>
    );
  }

  const labels: Record<ProjectSurfaceTab, string> = {
    tasks: projectTaskLabel(project.workMode),
    schedules: "定时任务",
    files: "文件",
    agents: "Agent 分工",
  };
  const tabs = tabIds.map((id) => ({ id, label: labels[id] }));
  // 游标停在哪一格：优先键盘焦点，焦点值失效时回落到当前选中项
  const stop = focusIndex >= 0 && focusIndex < tabs.length ? focusIndex : Math.max(selectedIndex, 0);

  /**
   * 方向键只移动焦点，不切换页签——这几个页签各自会拉取真实数据（文件、Agents、
   * 定时任务），自动激活会让按住方向键扫过一排变成连发请求。Enter/Space 由
   * 原生 button 的 click 触发 onChange，不需要在这里处理。
   */
  function moveFocus(event: React.KeyboardEvent) {
    const delta = tabNavDelta(event.key);
    if (!delta || !tabs.length) return;
    event.preventDefault();
    const next = nextTabIndex(stop, delta, tabs.length);
    setFocusIndex(next);
    buttons.current[next]?.focus();
  }

  return (
    <section aria-label="项目视图" className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2 text-xs">
        {/* 与全站 SegTabs(boxed) 统一同一套分段托盘语法：同心圆角 + 浅色白块浮起 + 弹簧滑动滑块 */}
        <div
          data-sliding={indicator ? "true" : undefined}
          className="ccode-seg-boxed inline-flex items-center"
          role="tablist"
          aria-label="项目视图"
          onKeyDown={moveFocus}
        >
          {indicator && (
            <span
              aria-hidden="true"
              className="ccode-seg-indicator"
              style={{
                width: indicator.width,
                transform: `translateX(${indicator.left}px)`,
              }}
            />
          )}
          {tabs.map((tab, index) => {
            const Icon = TAB_ICONS[tab.id];
            const selected = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  buttons.current[index] = node;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={tabStopIndex(index, stop)}
                onFocus={() => setFocusIndex(index)}
                onClick={() => onChange(tab.id)}
                className={`ccode-seg-boxed-item inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                  selected ? "font-medium text-l1" : "text-l3 hover:text-l1"
                }`}
              >
                <Icon
                  size={14}
                  strokeWidth={1.8}
                  className={selected ? "text-cta" : undefined}
                  aria-hidden="true"
                />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
      </div>
      <div
        data-project-main-scroll
        data-scrolled={scrolled ? "true" : undefined}
        onScroll={(event) => {
          const next = event.currentTarget.scrollTop > 2;
          setScrolled((prev) => (prev === next ? prev : next));
        }}
        className="min-h-0 flex-1 overflow-auto pt-0.5 pb-6"
      >
        {active === "tasks" && taskPanel}
        {children}
      </div>
    </section>
  );
}
