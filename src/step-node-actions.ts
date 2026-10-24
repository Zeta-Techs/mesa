/**
 * 步骤节点行的动作选择：**给不给入口、给哪个**。
 *
 * 原先是 StepFlow.tsx 里 `nodeActions()` 的一个 190 行 switch，判据和按钮长相织在一起，
 * 只能靠点界面验证。这里只抽「选哪个动作」，不抽长相——颜色/间距/disabled 的样式留在
 * 组件里，那是版式，改了看得见；而「什么时候给入口」是行为，改错了用户只看到按钮消失，
 * 不会报错（付费墙补充入口、EndNote 同步入口都这么坏过，见 tests/pipeline-task-titles）。
 *
 * 每条分支都是一串**有序**判据，顺序本身是语义：
 *
 *   human 的前两条（去笔记夹、资料库同步）刻意排在「after 未就绪」门之前。
 *   那两个节点是保存进项目之后才出现的收尾动作，未就绪时按钮**在但灰着**，
 *   位置先占住、告诉用户「还有这么一步」；而普通人工事项未就绪时干脆不出现。
 *   把两条提前到门之前就是这个差别，重排会把这层意思抹掉。
 */

import type { HumanTaskStateDto } from "./types";
import { isCitationStyleTask } from "./citation-style-choice.ts";
import { isInlineDecisionTaskTitle } from "./review-decisions.ts";
import { handbackTask } from "./handback-tasks.ts";
import {
  isEndnoteTaskTitle,
  isPaywallTaskTitle,
  isPendingConfirmTaskTitle,
  reviewActionVisible,
  type StepFlowNode,
  type StepRunStatus,
} from "./step-flow.ts";

/** agent 会话尾部判定：正在出字 / 等确认 / 已跑完（在等你）/ 无 */
export type AgentAttention = "working" | "confirm" | "done" | null;

/**
 * 域稿刷新是一句做法，不是文献库同步。
 * 旧标题「打开 EndNote 域稿并 Update 一次」含 EndNote，会误挂「同步到 Zotero / EndNote / 打开 papers」。
 */
export function isFieldDocRefreshTitle(title: string): boolean {
  return title.includes("域稿");
}

/** 落点在 papers/ 的事项 = 文献类交付，入口统一引到「文献与数据」 */
export function isPapersTarget(target: string | undefined): boolean {
  return (target ?? "").replace(/\\/g, "/").startsWith("papers/");
}

/**
 * 该事项的进料口。三个来源齐全（Zotero 导入 / 题录 / 扫目录）都在「文献与数据」，
 * 按已声明的文献来源高亮对应那一个——免得跳过去之后不知道点哪个。
 */
export function papersImportFocus(
  litSource: string | undefined,
): "zotero" | "files" | undefined {
  if (litSource === "zotero") return "zotero";
  if (litSource === "folder" || litSource === "endnote") return "files";
  return undefined;
}

/** 项目已有文献库：文案从「去导入」改成「加进库再重新导入即可」。 */
export function hasLitLibrary(litSource: string | undefined): boolean {
  return (
    litSource === "zotero" || litSource === "endnote" || litSource === "folder"
  );
}

/**
 * after 档事项的就绪口径：agent 已经产出了东西，才知道要做什么（付费墙清单是 agent
 * 筛完才列出来的）。v3.97 放宽到「会话尾部判定跑完」——旧口径死等 git 待评审，agent
 * 没提交时入口永远不出现（用户实测「没看见补充入口」）。
 *
 * 三处共用同一口径，必须单一出处：判「给不给入口」、判「行要不要压暗」、判
 * 「说明文字显示不显示」。前两处一旦分叉，就会出现「压暗的行里躺着可点的按钮」。
 */
export function stepNodeReady(
  runStatus: StepRunStatus,
  agentAttention: AgentAttention,
  human: { expectedCount?: number },
): boolean {
  return (
    runStatus === "review" ||
    runStatus === "done" ||
    agentAttention === "done" ||
    human.expectedCount != null
  );
}

/**
 * 行是否压暗（「还轮不到你」）。与 stepNodeReady 同一口径，反向使用。
 * 待确认清单已经挂在这一行上，不因为检索会话还没标完成就发灰。
 */
export function stepNodeWaiting(
  runStatus: StepRunStatus,
  agentAttention: AgentAttention,
  human: Pick<HumanTaskStateDto, "timing" | "title" | "expectedCount">,
  done: boolean,
): boolean {
  return (
    human.timing === "after" &&
    !stepNodeReady(runStatus, agentAttention, human) &&
    !done &&
    !isPendingConfirmTaskTitle(human.title) &&
    !isInlineDecisionTaskTitle(human.title)
  );
}

export type StepNodeAction =
  /** 精读保存后进笔记夹（沉浸阅读） */
  | { kind: "continue-notes"; enabled: boolean }
  /** EndNote 行的三个出口：同步到 Zotero / 同步到 EndNote / 打开 papers */
  | { kind: "endnote-sync"; enabled: boolean }
  /** 文献类交付：去「文献与数据」导入，按来源高亮对应进料口 */
  | {
      kind: "papers-import";
      focus: "zotero" | "files" | undefined;
      hasLibrary: boolean;
    }
  /** 非文献类交付（学校格式规范、审稿意见原文等）：直接选文件提交到落点 */
  | { kind: "submit-deliverable" }
  /** AI 写好的清单 / 模板，人打开填，再交回原对话（转载许可清单、投稿声明） */
  | { kind: "edit-handback" }
  /** 两份域稿用 Word 打开（在 Word 里换样式那一行） */
  | { kind: "open-field-docs" }
  /** 工作区已归档：主入口换成恢复 */
  | { kind: "restore-workspace" }
  /** 开工。示例课题精读步另挂「开读这一篇」，此时降为次要按钮 */
  | { kind: "start"; readPaper: boolean; readPaperPrimary: boolean }
  /** agent 进行中：去终端看看 */
  | { kind: "go-terminal"; agentDone: boolean }
  /** 去评审（含阻塞——阻塞也走评审入口） */
  | { kind: "go-review"; conflict: boolean };

export interface StepNodeActionContext {
  runStatus: StepRunStatus;
  agentAttention?: AgentAttention;
  /** 项目已声明的文献来源：zotero | endnote | folder | search | 空 */
  litSource?: string;
  /** 本步骤已有工作区（评审入口的前提） */
  hasWorkspace: boolean;
  /** 工作区存在且处于冲突态 */
  reviewConflict: boolean;
  /** 父级能接「恢复工作区」（工作区已归档） */
  canRestore: boolean;
  /** 父级传了 onReadPaper（仅示例课题精读步） */
  readPaper: boolean;
  /** 精读为主按钮（普通模板为 false，「开始」仍是主按钮） */
  readPaperPrimary: boolean;
}

/**
 * 选这一行该给什么动作。返回 null = 这一行不给入口。
 *
 * 未就绪、已完成的情况一律 null——不写「等 agent」之类的占位文案：节点排在 agent 之后，
 * 先后顺序看位置就知道，再标一句是同一件事说两遍。
 */
export function stepNodeAction(
  node: StepFlowNode,
  ctx: StepNodeActionContext,
): StepNodeAction | null {
  const agentAttention = ctx.agentAttention ?? null;
  switch (node.kind) {
    case "human": {
      // 1. 去笔记夹：排在就绪门之前（见文件头注释），未就绪时按钮在但灰着
      if (node.key === "continue-notes") {
        return { kind: "continue-notes", enabled: ctx.runStatus === "done" };
      }
      const human = node.human;
      // 2. 资料库同步：同上，按 key 或按标题认（模板改标题时由 pipeline-task-titles 兜住）
      if (
        node.key === "endnote-export" ||
        (human &&
          isEndnoteTaskTitle(human.title) &&
          !isFieldDocRefreshTitle(human.title))
      ) {
        return { kind: "endnote-sync", enabled: ctx.runStatus === "done" };
      }
      if (!human) return null;
      // 3. after 档：agent 还没产出东西就没什么可做的，连入口都不给
      if (
        human.timing === "after" &&
        !stepNodeReady(ctx.runStatus, agentAttention, human)
      ) {
        return null;
      }
      // 4. 行内点选与域稿不交文件。排在文献落点之前，避免报告落在 papers/ 时被送去导入。
      //    域稿给「用 Word 打开」；AI 写好、人来填的清单给「打开 / 交给 AI」，不给「提交产物」（2026-10-24）
      if (isCitationStyleTask(human.title) || isInlineDecisionTaskTitle(human.title)) {
        return null;
      }
      if (isFieldDocRefreshTitle(human.title)) {
        return node.done ? null : { kind: "open-field-docs" };
      }
      if (handbackTask(human.title)) {
        return node.done ? null : { kind: "edit-handback" };
      }
      // 5. 文献类交付统一去「文献与数据」：那里三个进料口齐全，在每个事项行再复制
      //    一套入口等于把同一件事摆三个地方。付费墙/待确认例外——它们的入口是行内
      //    的清单展开，列表钮会抢右缘。
      if (isPapersTarget(human.target)) {
        if (
          isPaywallTaskTitle(human.title) ||
          isPendingConfirmTaskTitle(human.title)
        ) {
          return null;
        }
        if (node.done) return null;
        return {
          kind: "papers-import",
          focus: papersImportFocus(ctx.litSource),
          hasLibrary: hasLitLibrary(ctx.litSource),
        };
      }
      // 6. 其余带落点的事项保留直接提交；纯脑力事项（无落点）只能勾选
      return human.target && !node.done
        ? { kind: "submit-deliverable" }
        : null;
    }
    case "agent": {
      // 「开始」不受当前节点门控（口径同 KickoffConfirmDialog：讨论种子/开始前事项
      // 只提醒不拦），active 时「去终端看看」同理常显
      if (ctx.runStatus === "pending" && ctx.canRestore) {
        return { kind: "restore-workspace" };
      }
      if (ctx.runStatus === "pending") {
        return {
          kind: "start",
          readPaper: ctx.readPaper,
          readPaperPrimary: ctx.readPaper && ctx.readPaperPrimary,
        };
      }
      if (ctx.runStatus === "active") {
        return { kind: "go-terminal", agentDone: agentAttention === "done" };
      }
      return null;
    }
    case "review": {
      if (!ctx.hasWorkspace) return null;
      const agentBusy = agentAttention === "working" || agentAttention === "confirm";
      if (!reviewActionVisible(ctx.runStatus, agentBusy)) return null;
      return { kind: "go-review", conflict: ctx.reviewConflict };
    }
    default:
      return null;
  }
}
