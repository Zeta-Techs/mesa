import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { parentDir, pathWithin } from "./path-utils.ts";

/**
 * 文件页 / 运行页文件树的文件操作（2026-10-26：原先右键只有新建文件夹和删除）。
 * 后端都在 fs_tree.rs：项目根内、不碰受保护路径、重名拒绝；复制进来的只认原生拖放交来的路径。
 */

/** 顶上那一行名字输入框在做什么 */
export type NameDraft =
  | { kind: "folder"; dir: string; value: string }
  | { kind: "file"; dir: string; value: string }
  | { kind: "rename"; path: string; value: string };

export function nameDraftPrompt(d: NameDraft): { label: string; placeholder: string } {
  const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  if (d.kind === "rename") return { label: `重命名 ${base(d.path)}：`, placeholder: "新名字" };
  return {
    label: `新建于 ${base(d.dir)}：`,
    placeholder: d.kind === "folder" ? "文件夹名称" : "文件名（如 notes.md）",
  };
}

/** 改名输入框默认选中「主名」部分，不选扩展名（同访达 / VS Code） */
export function stemSelection(name: string, isDir: boolean): [number, number] {
  const dot = name.lastIndexOf(".");
  return !isDir && dot > 0 ? [0, dot] : [0, name.length];
}

/** 提交名字输入：返回新文件 / 文件夹的路径 */
export function submitNameDraft(d: NameDraft, root: string): Promise<string> {
  const name = d.value.trim();
  if (d.kind === "folder") return invoke<string>("fs_create_dir", { root: d.dir, name });
  if (d.kind === "file") return invoke<string>("fs_create_file", { root: d.dir, name });
  return invoke<string>("fs_rename_path", { path: d.path, newName: name, root });
}

export function duplicatePath(path: string, root: string): Promise<string> {
  return invoke<string>("fs_duplicate_path", { path, root });
}

/** 「移动到…」：系统选文件夹窗口从项目根开始；选到项目外的直接报错不动 */
export async function pickAndMove(
  path: string,
  root: string,
  isWindows: boolean,
): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath: parentDir(path) ?? root,
    title: "移到项目里的哪个文件夹",
  });
  if (typeof picked !== "string") return null;
  if (!pathWithin(picked, root, isWindows)) throw new Error("只能移到这个项目里的文件夹");
  return invoke<string>("fs_move_path", { path, destDir: picked, root });
}

/** 拖进窗口的文件 / 文件夹复制到 destDir（后端只认原生拖放交来的路径），返回落地后的路径 */
export function importDropped(paths: string[], destDir: string, root: string): Promise<string[]> {
  return invoke<string[]>("fs_import_paths", { paths, destDir, root });
}

/** 拖放坐标 → 落点元素：Tauri 给的坐标有时是物理像素，两种都试 */
export function dropTargetAt(x: number, y: number, selector: string): HTMLElement | null {
  const scale = window.devicePixelRatio || 1;
  for (const [cx, cy] of [
    [x / scale, y / scale],
    [x, y],
  ] as const) {
    const el = document.elementFromPoint(cx, cy);
    const hit = el?.closest<HTMLElement>(selector);
    if (hit) return hit;
  }
  return null;
}
