/**
 * 评审页的 diff / 变更树 / 拦截项纯逻辑。
 *
 * 原先这些函数散在 WorkspaceReviewView.tsx（3681 行）的组件定义之间，虽然本身是纯的，
 * 但被关在一个 .tsx 里就没人测——而它们恰好是最该测的一类：解析 Git 统一 diff 的正则、
 * 折叠阈值、树的排序、拦截项的**优先级顺序**，全都是「改错了界面上只是看着有点怪」
 * 的地方，点界面很难发现。
 *
 * 组件那边只剩渲染。类型与函数一起搬，免得两处各写一份。
 */

import type { GitFileDto, WorkspaceHealthDto } from "./types";

/** 单行 diff：old/new 两侧各自的行号与文本。hunk 头自成一类行（两侧都无行号）。 */
export interface DiffLine {
  kind: "line" | "hunk";
  header?: string;
  oldNo: number | null;
  newNo: number | null;
  oldText: string;
  newText: string;
  oldKind: "context" | "delete" | "blank";
  newKind: "context" | "add" | "blank";
}

/** 被折起来的连续上下文（超过阈值时中间那段） */
export interface FoldedDiffBlock {
  kind: "fold";
  id: string;
  rows: DiffLine[];
}

export type DisplayDiffRow = DiffLine | FoldedDiffBlock;

export interface ChangeTreeNode {
  name: string;
  path: string;
  children: ChangeTreeNode[];
  file: GitFileDto | null;
}

/** 健康检查拦截项：key 用于给「主仓脏」挂快速提交入口，text 为面向用户的白话文案 */
export interface HealthBlocker {
  key:
    | "stale-lock"
    | "conflict"
    | "conflict-unknown"
    | "main-unfinished"
    | "main-dirty"
    | "main-off-base"
    | "gitdir";
  text: string;
}

/** 折叠阈值：连续上下文超过这么多行才折，中间只留首尾各 3 行 */
const FOLD_THRESHOLD = 12;
const FOLD_EDGE = 3;

/** 统一 diff 的 hunk 头：`@@ -旧起,旧长 +新起,新长 @@ 可选标题`。长度可省。 */
export function parseHunkStart(
  line: string,
): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

export function fileDiffCacheKey(
  worktreePath: string,
  path: string,
  revision: number,
): string {
  return `${worktreePath}\t${path}\t${revision}`;
}

export function absUnderRoot(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

/** 文件行末的小标：PDF 另加一句提醒（文件名本身看不出是不是二进制乱码）。 */
export function reviewFileChip(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (/\.pdf$/i.test(base)) return `${base} · 先看是否乱码`;
  return base;
}

/**
 * 解析 Git 统一 diff。
 *
 * 关键点是**删增配对**：diff 把一段改动写成先若干 `-` 再若干 `+`，逐行 push 会把一侧
 * 行号算错。这里把连续的删/增攒起来，按较长的一侧逐行配对，短的那侧补 blank——
 * 成对的改动显示成「同一行的旧文→新文」，两侧行号各自连续。
 *
 * 跳过 diff --git / index / --- / +++ / \ No newline 这些元信息行。
 */
export function parseDiff(text: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let removed: string[] = [];
  let added: string[] = [];

  const flushChanged = () => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const oldText = removed[i];
      const newText = added[i];
      rows.push({
        kind: "line",
        oldNo: oldText === undefined ? null : oldNo++,
        newNo: newText === undefined ? null : newNo++,
        oldText: oldText ?? "",
        newText: newText ?? "",
        oldKind: oldText === undefined ? "blank" : "delete",
        newKind: newText === undefined ? "blank" : "add",
      });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split("\n")) {
    const hunk = parseHunkStart(line);
    if (hunk) {
      flushChanged();
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      rows.push({
        kind: "hunk",
        header: line,
        oldNo: null,
        newNo: null,
        oldText: "",
        newText: "",
        oldKind: "blank",
        newKind: "blank",
      });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      flushChanged();
      const value = line.slice(1);
      rows.push({
        kind: "line",
        oldNo: oldNo++,
        newNo: newNo++,
        oldText: value,
        newText: value,
        oldKind: "context",
        newKind: "context",
      });
    }
  }
  flushChanged();
  return rows;
}

/** 变更文件 → 目录树。目录排在文件前、同级按名排序。 */
export function buildChangeTree(files: GitFileDto[]): ChangeTreeNode[] {
  const root: ChangeTreeNode = { name: "", path: "", children: [], file: null };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      let child = node.children.find((entry) => entry.name === part);
      if (!child) {
        const path = parts.slice(0, index + 1).join("/");
        child = { name: part, path, children: [], file: null };
        node.children.push(child);
      }
      node = child;
    });
    node.file = file;
  }
  const sort = (nodes: ChangeTreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = a.children.length > 0;
      const bDir = b.children.length > 0;
      return aDir === bDir ? a.name.localeCompare(b.name) : aDir ? -1 : 1;
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

/**
 * 折叠连续的上下文行：改动之间的长段原文没人看，折起来只留首尾各 3 行。
 * 阈值内（≤12 行）不折——为省三四行加一个可点的折叠条反而更碍事。
 * 已展开的块按 id 从 expanded 里认（id 按出现顺序编号，同一次解析内稳定）。
 */
export function foldContextRows(
  rows: DiffLine[],
  expanded: ReadonlySet<string>,
): DisplayDiffRow[] {
  const output: DisplayDiffRow[] = [];
  let context: DiffLine[] = [];
  let foldIndex = 0;
  const flush = () => {
    if (context.length <= FOLD_THRESHOLD) {
      output.push(...context);
    } else {
      const id = `fold-${foldIndex++}`;
      if (expanded.has(id)) {
        output.push(...context);
      } else {
        output.push(...context.slice(0, FOLD_EDGE));
        output.push({ kind: "fold", id, rows: context.slice(FOLD_EDGE, -FOLD_EDGE) });
        output.push(...context.slice(-FOLD_EDGE));
      }
    }
    context = [];
  };

  for (const row of rows) {
    if (
      row.kind === "line" &&
      row.oldKind === "context" &&
      row.newKind === "context"
    ) {
      context.push(row);
    } else {
      flush();
      output.push(row);
    }
  }
  flush();
  return output;
}

const UNFINISHED_WORD: Record<string, string> = {
  merge: "合并",
  rebase: "变基",
  "cherry-pick": "挑拣提交",
  revert: "撤销提交",
};

/**
 * 健康检查拦截项。顺序即界面顺序，按「先拦住你、再提醒你」排：
 * 冲突类（含无法预检）在最前，因为它们直接决定能不能合并；主仓脱节/不在主分支
 * 排在中间（要先修才谈得上合并）；主仓脏放最后，因为它挂着一个就地提交入口，
 * 排太前会把「这事其实有快速解法」的信号弱化。
 */
export function blockerList(health: WorkspaceHealthDto | null): HealthBlocker[] {
  if (!health) return [];
  const blockers: HealthBlocker[] = [];
  // 残留锁在最前：它不清掉，下面每一项的处理（含提交）都会失败
  if (health.staleLock)
    blockers.push({
      key: "stale-lock",
      text: "上次 git 操作没结束就被关掉了，留下的锁文件挡着保存",
    });
  if (health.conflict === true)
    blockers.push({
      key: "conflict",
      text: "与主分支存在冲突（两边改了同一个地方，需要选一边）",
    });
  if (health.conflict === null)
    blockers.push({ key: "conflict-unknown", text: "当前 Git 版本无法预检冲突" });
  // 做到一半的 git 操作排在「没保存的改动」前：它在时主文件夹必然也脏，先放弃它才谈得上提交
  if (health.mainUnfinished)
    blockers.push({
      key: "main-unfinished",
      text: `主文件夹停在一次没做完的 git ${UNFINISHED_WORD[health.mainUnfinished] ?? "操作"}里`,
    });
  if (health.mainDirty)
    blockers.push({ key: "main-dirty", text: "主文件夹里还有没保存的改动" });
  if (health.gitdirDetached)
    blockers.push({
      key: "gitdir",
      text: "工作树与主仓脱节，请重新挂载",
    });
  if (health.mainOffBase)
    blockers.push({
      key: "main-off-base",
      text:
        health.mainBranch && health.mainBranch !== "HEAD"
          ? `主文件夹当前在 ${health.mainBranch} 上，不在主分支上`
          : "主文件夹当前不在主分支上",
    });
  return blockers;
}

export function blockerText(health: WorkspaceHealthDto | null): string[] {
  return blockerList(health).map((blocker) => blocker.text);
}
