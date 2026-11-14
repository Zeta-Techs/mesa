import type { FilePreviewSnapshot } from "./file-preview.ts";

/**
 * 预览在两个位置之间搬家时（文件页侧栏 ⇄ 窗口预览）带上没保存的修改（2026-10-26）。
 * 两处是不同的编辑器实例：原先一搬就得先确认「丢掉修改」。宿主搬家前 arm 一下这个路径，
 * 旧编辑器卸载时把内容寄存在这里，新编辑器加载同一路径时取走。没 arm 的卸载不寄存——
 * 关预览前确认过「丢掉」的修改不能借这里复活。
 */

export interface PreviewDraft {
  text: string;
  /** 寄存时的磁盘基线（保存时以它为版本号；新编辑器读到的磁盘内容与它不同就提示有新版本） */
  baseline: FilePreviewSnapshot;
  mode: "read" | "edit";
  viewState: unknown;
}

const ARM_MS = 5000;
const STORAGE_KEY = "ccode.draftHandoff";
const armed = new Map<string, number>();
const drafts = new Map<string, PreviewDraft>();

function saveCrossWindowDraft(path: string, draft: PreviewDraft, now: number): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        path,
        expiresAt: now + ARM_MS,
        draft: { text: draft.text, baseline: draft.baseline, mode: draft.mode, viewState: null },
      }),
    );
  } catch {
    /* 隐私模式或配额满时仅保留同窗内存寄存 */
  }
}

function takeCrossWindowDraft(path: string, now: number): PreviewDraft | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: string; expiresAt?: number; draft?: PreviewDraft };
    if (parsed.path !== path) return null;
    localStorage.removeItem(STORAGE_KEY);
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < now || !parsed.draft) return null;
    return parsed.draft;
  } catch {
    return null;
  }
}

export function armDraftHandoff(path: string, now = Date.now()): void {
  armed.set(path, now + ARM_MS);
}

/** 旧编辑器卸载时调用：arm 过且没过期才寄存，返回是否寄存了 */
export function stashDraftIfArmed(path: string, draft: PreviewDraft, now = Date.now()): boolean {
  const until = armed.get(path);
  armed.delete(path);
  if (until === undefined || until < now) return false;
  drafts.set(path, draft);
  saveCrossWindowDraft(path, draft, now);
  return true;
}

/** 新编辑器加载时取走（只取一次；支持同窗口重挂与拆出独立文件窗口） */
export function takeDraft(path: string, now = Date.now()): PreviewDraft | null {
  const d = drafts.get(path) ?? null;
  if (d) {
    drafts.delete(path);
    takeCrossWindowDraft(path, now);
    return d;
  }
  return takeCrossWindowDraft(path, now);
}
