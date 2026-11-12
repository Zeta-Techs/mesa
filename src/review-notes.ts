/**
 * 评审页「退回意见」的本机存放（按工作副本，2026-11-11 起关掉评审再进来还在）。
 * 评审页自己读写；研讨页「加进退回意见」（2026-11-12）也往这里追加，追加后发事件让开着的评审页读回，
 * 免得评审页下一次改动把旧内容写回去。退回或保存进项目后由评审页清掉。
 */
import { appendReviewLine } from "./draft-review.ts";

const NOTES_KEY = (worktreePath: string) => `mesa.reviewNotes:${worktreePath}`;

/** 研讨页追加了意见：detail = 工作副本路径 */
export const REVIEW_NOTES_EVENT = "mesa:review-notes-appended";

export function readStoredNotes(worktreePath: string): string {
  try {
    return localStorage.getItem(NOTES_KEY(worktreePath)) ?? "";
  } catch {
    return "";
  }
}

export function storeNotes(worktreePath: string, notes: string) {
  try {
    if (notes.trim()) localStorage.setItem(NOTES_KEY(worktreePath), notes);
    else localStorage.removeItem(NOTES_KEY(worktreePath));
  } catch {
    /* 存不了只是关掉后不留，不影响退回 */
  }
}

/** 往这个工作副本的退回意见里追加一行（同一行已有就不重复），通知开着的评审页读回 */
export function appendStoredNote(worktreePath: string, line: string) {
  storeNotes(worktreePath, appendReviewLine(readStoredNotes(worktreePath), line));
  try {
    window.dispatchEvent(new CustomEvent(REVIEW_NOTES_EVENT, { detail: worktreePath }));
  } catch {
    /* 没有 window（测试）时只写存储 */
  }
}
