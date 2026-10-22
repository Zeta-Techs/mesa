/**
 * 侧栏项目树的置顶与组内顺序（纯逻辑，tests/project-tree.test.ts）。
 *
 * 置顶是界面偏好（同分组折叠态），记本机 localStorage，不进项目注册表 / 档案卡。
 * 置顶的课题从原分组里拿出、单列「置顶」段（不在两处重复出现），按置顶先后排。
 * 组内顺序（拖动排序）同样只记本机：一张全局路径表，只比较同组课题的相对先后，
 * 不在表里的（新加的）排在组内最后、彼此保持原顺序。置顶段的顺序就是 pins 表本身。
 * 路径比较走方言层 samePath（Windows 大小写/分隔符不敏感）。
 */
import { samePath } from "./path-utils.ts";

export const PROJECT_PINS_KEY = "ccode.projectTreePins";
export const PROJECT_ORDER_KEY = "ccode.projectTreeOrder";

export function isPinned(
  pins: readonly string[],
  path: string,
  isWindows: boolean,
): boolean {
  return pins.some((p) => samePath(p, path, isWindows));
}

/** 切换置顶：置顶追加到末尾（按先后排），取消即移除 */
export function togglePin(
  pins: readonly string[],
  path: string,
  isWindows: boolean,
): string[] {
  return isPinned(pins, path, isWindows)
    ? pins.filter((p) => !samePath(p, path, isWindows))
    : [...pins, path];
}

/** 拆成置顶段与其余：置顶段按 pins 顺序；已不存在的置顶路径（课题被移除）自然被跳过 */
export function splitPinned<T extends { repoPath: string }>(
  rows: readonly T[],
  pins: readonly string[],
  isWindows: boolean,
): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  for (const p of pins) {
    const hit = rows.find((r) => samePath(r.repoPath, p, isWindows));
    if (hit && !pinned.includes(hit)) pinned.push(hit);
  }
  return { pinned, rest: rows.filter((r) => !pinned.includes(r)) };
}

/** 读 localStorage 里的置顶表 / 顺序表：坏数据当空表，不让一行脏值弄挂侧栏 */
export function parsePins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 按顺序表排：表里有的按表中先后，其余（新加的）排在后面并保持传入顺序。稳定、不丢行 */
export function applyOrder<T>(
  rows: readonly T[],
  order: readonly string[],
  pathOf: (row: T) => string,
  isWindows: boolean,
): T[] {
  const rank = (row: T) => {
    const i = order.findIndex((p) => samePath(p, pathOf(row), isWindows));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return rows
    .map((row, i) => ({ row, i, r: rank(row) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r - b.r))
    .map((x) => x.row);
}

/** 组内拖动落定：把一组（按当前显示顺序）里 from 挪到 to，写回表。
 *  表里这组的旧条目全部摘掉、新顺序整组追加到末尾——只有同组相对先后有意义，
 *  所以追加到哪儿都不影响别的组；置顶段拿 pins 表当 list 用同一个函数。 */
export function reorderGroup(
  list: readonly string[],
  groupPaths: readonly string[],
  from: number,
  to: number,
  isWindows: boolean,
): string[] {
  if (from === to || from < 0 || to < 0 || from >= groupPaths.length || to >= groupPaths.length)
    return [...list];
  const seq = [...groupPaths];
  const [moved] = seq.splice(from, 1);
  seq.splice(to, 0, moved);
  const rest = list.filter((p) => !groupPaths.some((g) => samePath(g, p, isWindows)));
  return [...rest, ...seq];
}
