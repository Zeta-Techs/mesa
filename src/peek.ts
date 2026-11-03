/**
 * 看一眼（2026-11-03 项目内协作一期，docs/design-project-coordination.md）前端纯逻辑：
 * - openPeerCount：开工时数一次同项目还开着的其他工作（不含内部后台对话与登录标签）；
 * - peekSectionLines：有其他工作时任务书带「同项目的其他工作」一节，告诉 Agent 怎么只读看一眼（mesa_helper peek，Rust 侧 peek.rs）。
 */
import type { RunDto } from "./types.ts";

export function openPeerCount(runs: readonly Pick<RunDto, "closedAt" | "internal" | "taskKind">[]): number {
  return runs.filter((r) => !r.closedAt && !r.internal && r.taskKind !== "login").length;
}

/** 项目说明（对话注入自动档 / 目标包）里的一句：同项目有别的工作开着时才带 */
export function peekContextLine(peers: number, isWindows: boolean): string {
  if (peers <= 0) return "";
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return `同项目还有 ${peers} 段别的工作开着：想知道它们在做什么、改了什么，跑 \`${tool} peek agents\`（只读，不打扰它们；别人工作副本里的文件不要改）。`;
}

export function peekSectionLines(peers: number, isWindows: boolean): string[] {
  if (peers <= 0) return [];
  const tool = isWindows ? "& $env:MESA_PEEK_TOOL" : '"$MESA_PEEK_TOOL"';
  return [
    "## 同项目的其他工作",
    `开工时这个项目还有 ${peers} 段别的工作开着。想知道它们在做什么、改了什么：\`${tool} peek agents\`，再细看 \`peek changes --worker 名字\` / \`peek runs --worker 名字\`。只读，不打扰它们。`,
    "别人工作副本里的文件不要改；要用它们的产物，等评审采纳进项目再读。",
    "",
  ];
}
