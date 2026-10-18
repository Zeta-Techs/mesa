/**
 * 侧栏项目树的置顶（纯逻辑，tests/project-tree.test.ts）。
 *
 * 置顶是界面偏好（同分组折叠态），记本机 localStorage，不进项目注册表 / 档案卡。
 * 置顶的课题从原分组里拿出、单列「置顶」段（不在两处重复出现），按置顶先后排。
 * 路径比较走方言层 samePath（Windows 大小写/分隔符不敏感）。
 */
import { samePath } from "./path-utils.ts";

export const PROJECT_PINS_KEY = "ccode.projectTreePins";

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

/** 读 localStorage 里的置顶表：坏数据当空表，不让一行脏值弄挂侧栏 */
export function parsePins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
