/** 已保存步骤上改台账后顺手提交进项目（2026-11-05 排查）：步骤保存进项目后，待确认清单、类型标签、待获取
 *  这些台账改动直接写项目根；不提交，项目就一直是脏的——下一步开工被「有没提交的改动」拦下，
 *  补料 / 跟进并入时也带不过去。后端 `commit_project_ledger` 只提交给定的台账文件、别的改动不碰。
 *  所有调用点走这一个入口；失败不拦界面动作，由调用方把 note 放进已有的提示位。 */

import { invoke } from "@tauri-apps/api/core";

/** 能经这条路提交的台账（与后端白名单同一份） */
export const PROJECT_LEDGER_FILES = [
  "papers/included.json",
  "papers/included.md",
  "papers/to-fetch.md",
  "papers/to-fetch.ris",
  "papers/endnote-import.ris",
  "papers/screening.md",
] as const;

/** 去重、只留白名单里的，按白名单顺序 */
export function ledgerCommitPaths(paths: Iterable<string>): string[] {
  const wanted = new Set([...paths].map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  return PROJECT_LEDGER_FILES.filter((p) => wanted.has(p));
}

export function ledgerCommitFailureNote(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return `改动已写进项目，但没能自动提交（${text}）：到项目的改动面板手动提交这几个清单文件。`;
}

type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** 提交给定的台账文件。返回 null = 提交了或没东西可提交；失败返回给人看的一句话（不抛错） */
export async function commitProjectLedger(
  projectRoot: string,
  paths: Iterable<string>,
  call: Call = invoke,
): Promise<string | null> {
  const list = ledgerCommitPaths(paths);
  if (list.length === 0) return null;
  try {
    await call("commit_project_ledger", { projectRoot, paths: list });
    return null;
  } catch (reason) {
    return ledgerCommitFailureNote(reason);
  }
}
