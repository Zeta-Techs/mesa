/**
 * 项目页文件栏（2026-11-11 用户拍板「项目页的文件统一从侧边打开」）的纯逻辑：
 * 与项目助手共用 App 主区右边的停靠位、同一位置轮流；宽度、谁在前、上一个 / 下一个文件在这里算。
 * 宿主 ProjectFilePaneHost 读 store、量宽度；配 tests/project-file-pane.test.ts。
 */
import { samePath } from "./path-utils.ts";

export interface ProjectFilePaneFile {
  path: string;
  name: string;
}

export interface ProjectFilePaneReq extends ProjectFilePaneFile {
  /** 打开它的项目（换项目或离开项目页时文件栏收起） */
  projectRoot: string;
  /** 读盘白名单根：本步文件在工作副本里就是工作副本，其余是项目根 */
  root: string;
  /** 打开时那份清单（本步文件按显示顺序）：栏头 ↑↓ 在里面切换；单个文件不给 */
  list?: ProjectFilePaneFile[];
  /** 来处小字：「文献检索与筛选 · 本步文件」；不给就不写 */
  from?: string;
  /** 栏头「问 AI」（资料列表接线）：按此刻看的文件路径开商量对话；不给就不显示 */
  askAi?: (path: string) => void;
  versions?: { root: string; workspaceId?: string };
  nonce: number;
}

export type DockFront = "assistant" | "file";

export const FILE_PANE_WIDTH_DEFAULT = 560;
export const FILE_PANE_WIDTH_MIN = 360;
export const FILE_PANE_WIDTH_MAX = 960;
export const FILE_PANE_WIDTH_KEY = "ccode.projectFilePane.width";

/** 拖出来的宽度夹进 360–960；负数 = 双击恢复默认。文件常要看 PDF / 表格，比项目助手宽 */
export function clampFilePaneWidth(width: number): number {
  if (!Number.isFinite(width) || width < 0) return FILE_PANE_WIDTH_DEFAULT;
  return Math.round(Math.min(FILE_PANE_WIDTH_MAX, Math.max(FILE_PANE_WIDTH_MIN, width)));
}

/** 停靠位此刻给谁：只开着一个就是它；两个都开着看最后叫出来的那个 */
export function dockOccupant(front: DockFront, hasAssistant: boolean, hasFile: boolean): DockFront | null {
  if (hasAssistant && hasFile) return front;
  if (hasFile) return "file";
  if (hasAssistant) return "assistant";
  return null;
}

/** 清单里的上一个 / 下一个文件；不在清单里或到头了给 null */
export function neighborFile(
  list: ProjectFilePaneFile[] | undefined,
  path: string,
  delta: -1 | 1,
  isWindows: boolean,
): ProjectFilePaneFile | null {
  if (!list?.length) return null;
  const index = list.findIndex((f) => samePath(f.path, path, isWindows));
  if (index < 0) return null;
  return list[index + delta] ?? null;
}

/**
 * 文件栏要不要自己收起：只在项目页换到了别的项目时收（离开项目页只藏起来，回来还在、没保存的改动也在）。
 * 只认「变了」——跨页带着请求来时 store 里的项目可能还是上一个，同一帧不能当成换项目；有没保存的改动不收
 */
export function filePaneShouldClose(input: {
  paneRoot: string;
  page: string;
  prevProject: string | null | undefined;
  project: string | null;
  dirty: boolean;
  isWindows: boolean;
}): boolean {
  if (input.dirty || input.page !== "workspaces") return false;
  if (input.prevProject === undefined || !input.project) return false;
  if (input.prevProject && samePath(input.prevProject, input.project, input.isWindows)) return false;
  return !samePath(input.project, input.paneRoot, input.isWindows);
}
