import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // 当前选中项变化（含键盘切换、外部跳转）时，把游标收回到它身上
  useEffect(() => {
    if (selectedIndex >= 0) setFocusIndex(selectedIndex);
  }, [selectedIndex]);

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
    agents: "Agents",
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
      <div className="mb-4 flex shrink-0 items-end border-b border-hairline">
      <div
        className="flex items-center gap-1"
        role="tablist"
        aria-label="项目视图"
        onKeyDown={moveFocus}
      >
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
              className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors ${
                selected
                  ? "border-cta text-l1"
                  : "border-transparent text-l3 hover:text-l1"
              }`}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>
      {trailing && <div className="ml-auto flex items-center pb-1">{trailing}</div>}
      </div>
      <div
        data-project-main-scroll
        className="min-h-0 flex-1 overflow-auto pb-6"
      >
        {active === "tasks" && taskPanel}
        {children}
      </div>
    </section>
  );
}
