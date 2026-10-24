/** 项目页页签。「对话」2026-10-23 撤掉（侧栏挂对话第一期）：项目的对话挂在侧栏项目树下面，
 *  项目页只管课题本身；存过「chats」的项目回落到默认页签 */
export type ProjectSurfaceTab =
  | "tasks"
  | "schedules"
  | "files"
  | "agents";

export const DEFAULT_PROJECT_SURFACE_TAB: ProjectSurfaceTab = "tasks";

export function projectTaskLabel(workMode: string | null | undefined): string {
  if (workMode === "coding") return "编程任务";
  if (workMode === "office") return "工作任务";
  return "科研任务";
}

export function projectSurfaceTabsForMode(
  _workMode: string | null | undefined,
): ProjectSurfaceTab[] {
  return ["tasks", "schedules", "files", "agents"];
}

export function normalizeProjectSurfaceTab(
  value: string | null | undefined,
  workMode?: string | null,
): ProjectSurfaceTab {
  const tabs = projectSurfaceTabsForMode(workMode);
  return tabs.includes(value as ProjectSurfaceTab)
    ? (value as ProjectSurfaceTab)
    : DEFAULT_PROJECT_SURFACE_TAB;
}

export function projectSurfaceStorageKey(projectPath: string): string {
  return `ccode.projectSurface.${projectPath}`;
}

export function readProjectSurfaceTab(
  projectPath: string,
  storage?: Pick<Storage, "getItem">,
  workMode?: string | null,
): ProjectSurfaceTab {
  try {
    return normalizeProjectSurfaceTab(
      (storage ?? window.localStorage).getItem(projectSurfaceStorageKey(projectPath)),
      workMode,
    );
  } catch {
    return DEFAULT_PROJECT_SURFACE_TAB;
  }
}
