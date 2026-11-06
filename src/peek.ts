/**
 * 看一眼（2026-11-03 项目内协作一期，docs/design-project-coordination.md）前端纯逻辑：
 * - openPeerCount：开工时数一次同项目还开着的其他工作（不含内部后台对话与登录标签）；
 * - peekSectionLines：有其他工作时任务书带「同项目的其他工作」一节，告诉 Agent 怎么只读看一眼（mesa_helper peek，Rust 侧 peek.rs）；
 * - changeLine：工作台任务面板「改了哪些文件」每行的加减字样（Rust peek_changes）。
 */
import type { ChangedFileDto, RunDto } from "./types.ts";

/** 任务面板先列这么多个改动文件，其余点开 */
export const CHANGES_SHOWN = 8;

export function changeLine(f: Pick<ChangedFileDto, "added" | "removed" | "newFile">): string {
  if (f.newFile) return "新文件";
  if (f.added === "-") return "二进制";
  // 不是 Git 的工作副本（非 Git 项目的目标）：知道改过，没有行数（peek.rs NO_LINES）
  if (f.added === "~") return "改过";
  return `+${f.added} −${f.removed}`;
}

export function openPeerCount(runs: readonly Pick<RunDto, "closedAt" | "internal" | "taskKind">[]): number {
  return runs.filter((r) => !r.closedAt && !r.internal && r.taskKind !== "login").length;
}

/** 项目说明（对话注入自动档 / 目标包）里的一句：同项目有别的工作开着时才带 */
export function peekContextLine(peers: number, isWindows: boolean): string {
  if (peers <= 0) return "";
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return `同项目还有 ${peers} 段别的工作开着：想知道它们在做什么、改了什么，跑 \`${tool} peek agents\`（只读，不打扰它们；别人工作副本里的文件不要改）；要给它们留话用 \`${tool} tell --to 名字 "…"\`。`;
}

export function peekSectionLines(peers: number, isWindows: boolean): string[] {
  if (peers <= 0) return [];
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return [
    "## 同项目的其他工作",
    `开工时这个项目还有 ${peers} 段别的工作开着。想知道它们在做什么、改了什么：\`${tool} peek agents\`，再细看 \`peek changes --worker 名字\` / \`peek runs --worker 名字\`。只读，不打扰它们。`,
    `要告诉它们一件会影响它们的事（比如改了它们要读的文件格式）：\`${tool} tell --to 名字 "要说的话"\`，它空闲时 Mesa 送进它的对话。别人工作副本里的文件不要改；要用它们的产物，等评审采纳进项目再读。`,
    "",
  ];
}
