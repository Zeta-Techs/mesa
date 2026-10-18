/**
 * git 状态的分组与白话文案（界面白话化：白话主展示，字母徽标降为二级 mono + 悬浮中文）。
 * 纯逻辑，供改动面板分组渲染与徽标悬浮 title 复用。
 */

export type StatusGroupKey = "unmerged" | "modified" | "added" | "deleted";

/** 中文组名（改动面板文件列表的分组标题） */
export const STATUS_GROUP_LABEL: Record<StatusGroupKey, string> = {
  unmerged: "冲突的",
  modified: "修改的",
  added: "新增的",
  deleted: "删除的",
};

/** 状态字母 → 白话说明（徽标悬浮 title 用「字母 · 白话」双层呈现） */
export const STATUS_WORD: Record<string, string> = {
  M: "已修改",
  A: "新文件（待提交）",
  "??": "新文件",
  D: "已删除",
  R: "已重命名",
  U: "未合并（冲突）",
  UU: "未合并（冲突）",
  AA: "双方都新增（冲突）",
  DD: "双方都删除（冲突）",
};

/** 徽标悬浮 title：保留字母供程序员扫读，附白话说明 */
/** Mesa 自己写的验收账本。未跟踪时不算「你的改动未存入历史」。 */
export function isAcceptanceLedgerPath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name === "acceptance-log.jsonl" || name === "acceptance-log.lock";
}

/** 积累面台账（2026-10-13 双台账口径，与后端合并闸门 review_contract.rs 同口径镜像）：
 * 雷达台账（inbox/watch-seen/watch-followup）、用户笔记（notes/*.md 与配图 notes/assets/）、验收账本的任何
 * 常规状态都不算「你的改动未存入历史」；reading-list / watch-explains /
 * pending-registrations 只豁免未跟踪态（防呆：agent 违规提交后变 tracked 的 M 要显形）。 */
export function isAccumulationLedgerPath(path: string, status: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^"|"$/g, "");
  const anyState =
    p === "notes/inbox.md" ||
    p === "papers/watch-seen.md" ||
    p === "papers/watch-followup.md" ||
    p === ".ccode/acceptance-log.jsonl" ||
    p === ".ccode/acceptance-log.lock" ||
    (p.startsWith("notes/") && p.endsWith(".md")) ||
    p.startsWith("notes/assets/") ||
    p.startsWith(".ccode/watch/");
  if (anyState) return true;
  return (
    status === "??" &&
    (p === "papers/reading-list.md" ||
      p === ".ccode/watch-explains.json" ||
      p === ".ccode/pending-registrations.json")
  );
}

function isReviewNotesPath(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name === "review-notes.md";
}

export function userDirtyFiles<T extends { path: string; status: string }>(
  files: readonly T[],
): T[] {
  return files.filter((file) => {
    if (isReviewNotesPath(file.path)) return false;
    if (isAccumulationLedgerPath(file.path, file.status)) return false;
    return !(file.status === "??" && isAcceptanceLedgerPath(file.path));
  });
}

/** Mesa 自有的项目档案路径（`.ccode/` 与 `.gitignore`，与后端 commit_project_bootstrap 的
 *  BOOTSTRAP_PATHS 同口径）：开工前、评审前由 Mesa 自己提交，不该当成「你的改动」催你存。 */
export function isMesaCardPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/^"|"$/g, "");
  return p === ".gitignore" || p === ".ccode" || p.startsWith(".ccode/");
}

/** 项目页「N 处改动未存入历史」与开工弹层提醒的口径：你的改动，去掉 Mesa 自有档案。
 *  评审页的主文件夹提交面板仍用 userDirtyFiles——那里要能看见并提交一切挡合并的改动。 */
export function userWorkDirtyFiles<T extends { path: string; status: string }>(
  files: readonly T[],
): T[] {
  return userDirtyFiles(files).filter((file) => !isMesaCardPath(file.path));
}

export function statusBadgeTitle(status: string): string {
  return `${status} · ${STATUS_WORD[status] ?? status}`;
}

const UNMERGED_STATUS = new Set(["U", "UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

/** 状态字母归入四组之一；冲突优先，M/R 及未知状态兜底进「修改的」 */
export function statusGroupKey(status: string): StatusGroupKey {
  if (UNMERGED_STATUS.has(status)) return "unmerged";
  if (status === "A" || status === "??") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

export interface StatusGroup<T> {
  key: StatusGroupKey;
  label: string;
  files: T[];
}

/** 按状态分组，组内保持原顺序，组序固定为 修改 → 新增 → 删除，空组不返回 */
export function groupFilesByStatus<T extends { status: string }>(
  files: T[],
): StatusGroup<T>[] {
  const buckets = new Map<StatusGroupKey, T[]>();
  for (const file of files) {
    const key = statusGroupKey(file.status);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(file);
    else buckets.set(key, [file]);
  }
  const order: StatusGroupKey[] = ["unmerged", "modified", "added", "deleted"];
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({
      key,
      label: STATUS_GROUP_LABEL[key],
      files: buckets.get(key)!,
    }));
}
