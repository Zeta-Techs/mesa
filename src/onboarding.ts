/**
 * 上手引导（2026-10-20 起，2026-10-29 改全屏向导 + 三段核心）的纯逻辑：步骤表、完成判定、进度、
 * 首次判定、提示文案与本地持久化。
 *
 * 完成状态一律由真实数据推导（装了哪家 Agent、有没有连接 / 对话 / 项目），不另存「做到第几步」——
 * 用户跳着做、在别处做完、事后删掉，向导和侧栏进度都如实反映。
 * 「切到终端看看」「对话标题」不再是步骤，降为第一段对话出现时弹一次的小提示（acks 记已知晓）。
 * 界面（全屏向导、侧栏进度行、完成提示）在 components/OnboardingGuide.tsx / OnboardingWizard.tsx。
 */

export type OnboardingStepId = "connect" | "chat" | "project";

/** 小提示的确认键：终端那条用户真切过一次终端也记 */
export type OnboardingAckId = "terminal" | "naming";

/** 推导完成状态用的事实，全部来自 store 里已有的数据 */
export type OnboardingFacts = {
  /** 已安装（detect 到可执行文件）的 agent id，按 AGENTS 顺序 */
  installedAgents: readonly string[];
  gatewayCount: number;
  profileCount: number;
  /** 非 Mesa 内部的对话数：后台起名 / 摘要这类内部 AI 不算用户开过对话 */
  userSessionCount: number;
  /** 已添加（登记）的项目数 */
  projectCount: number;
  /** 已装好且官方账号已登录的 agent id（只在还没有连接时探测）：有就能一键接入，不必建网关 */
  officialReady?: readonly string[];
};

/** 已装 Agent 的官方账号探测结果：ready = 已登录（可一键接入），login = 还没登录，none = 这家没有官方账号登录方式；
 *  没探到（还在读）的 Agent 不在表里 */
export type OnboardingOfficialProbe = Record<string, "ready" | "login" | "none">;

/** unset = 还没判定过；active = 引导进行中；dismissed = 用户收起或老用户；done = 全部完成 */
export type OnboardingStatus = "unset" | "active" | "dismissed" | "done";

export type OnboardingState = {
  status: OnboardingStatus;
  /** 向导自动弹过一次（关掉也算） */
  welcomed: boolean;
  /** 小提示已讲过 / 用户已经知道 */
  acks: Partial<Record<OnboardingAckId, true>>;
};

export const ONBOARDING_STORAGE_KEY = "ccode.onboarding";

export const DEFAULT_ONBOARDING: OnboardingState = {
  status: "unset",
  welcomed: false,
  acks: {},
};

export type OnboardingStep = {
  id: OnboardingStepId;
  /** 侧栏进度行和向导进度点上的短名 */
  title: string;
  /** 向导页大标题 */
  headline: string;
  /** 一句话：这一步解决什么 */
  summary: string;
};

/** 顺序即推荐顺序；「当前步」= 第一个没完成的 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: "connect",
    title: "接上 AI",
    headline: "先把 AI 接上",
    summary: "Mesa 本身不带 AI，它调度的是装在你电脑上的 AI 命令行工具（Agent）。装一个，再连上你的账号或服务商密钥。",
  },
  {
    id: "chat",
    title: "聊第一句",
    headline: "发一句话，确认接通",
    summary: "有回复就说明连接是通的。之后每段对话都在 Mesa 里留档，随时回来找。",
  },
  {
    id: "project",
    title: "建第一个项目",
    headline: "开一个项目，开始做课题",
    summary: "项目是 Mesa 的工作单位：一个课题一个文件夹，对话、步骤、文件都挂在它名下。",
  },
];

export function stepById(id: OnboardingStepId): OnboardingStep {
  return ONBOARDING_STEPS.find((s) => s.id === id)!;
}

export function isStepDone(id: OnboardingStepId, facts: OnboardingFacts): boolean {
  switch (id) {
    case "connect":
      return facts.profileCount > 0;
    case "chat":
      return facts.userSessionCount > 0;
    case "project":
      return facts.projectCount > 0;
  }
}

export type OnboardingProgress = {
  steps: { step: OnboardingStep; done: boolean }[];
  doneCount: number;
  total: number;
  /** 第一个没完成的步骤；全部完成为 null */
  current: OnboardingStepId | null;
};

export function onboardingProgress(facts: OnboardingFacts): OnboardingProgress {
  const steps = ONBOARDING_STEPS.map((step) => ({ step, done: isStepDone(step.id, facts) }));
  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    total: steps.length,
    current: steps.find((s) => !s.done)?.step.id ?? null,
  };
}

/** 完成集合（按步骤顺序） */
export function doneStepIds(progress: OnboardingProgress): OnboardingStepId[] {
  return progress.steps.filter((s) => s.done).map((s) => s.step.id);
}

/** 两次快照之间新完成的步骤，按步骤顺序 */
export function newlyDone(
  prev: readonly OnboardingStepId[],
  next: readonly OnboardingStepId[],
): OnboardingStepId[] {
  const before = new Set(prev);
  return ONBOARDING_STEPS.map((s) => s.id).filter((id) => next.includes(id) && !before.has(id));
}

/** 「接上 AI」这一屏现在该显示哪一块：没装 Agent → 先装；装了没连 → 选连接方式；已连 → 做完 */
export type ConnectStage = "install" | "choose" | "done";

export function connectStage(facts: OnboardingFacts): ConnectStage {
  if (facts.profileCount > 0) return "done";
  return facts.installedAgents.length > 0 ? "choose" : "install";
}

/** 一键接入官方账号的按钮文案（向导、侧栏提示共用） */
export function officialShortcutLabel(agentLabel: string): string {
  return `用 ${agentLabel} 官方账号`;
}

/**
 * 首次判定（只在 status 为 unset 时做一次，之后不再按数据回头改）：
 * 已有连接的是老用户，引导直接收起（不弹向导、不占侧栏，帮助菜单可再打开）；其余当新用户。
 */
export function decideInitialStatus(facts: OnboardingFacts): "active" | "dismissed" {
  return facts.profileCount > 0 ? "dismissed" : "active";
}

/** 步骤完成时的结果句 */
function doneHeadline(
  id: OnboardingStepId,
  ctx: { installedLabel?: string | null },
): string | null {
  switch (id) {
    case "connect":
      return ctx.installedLabel ? `${ctx.installedLabel} 已接通` : "连接已添加";
    case "chat":
      return "第一段对话开始了";
    case "project":
      return "项目建好了";
  }
}

/** 「下一步」那一句（向导关着时弹在右下角） */
function nextLine(next: OnboardingStepId): string {
  switch (next) {
    case "connect":
      return "下一步：点侧栏「上手引导」，装一个 Agent 并接上账号或密钥。";
    case "chat":
      return "下一步：点侧栏「新对话」，发一句话试试连接通不通。";
    case "project":
      return "下一步：建第一个项目。点侧栏「项目」旁的 ＋。Mesa 围绕项目文件夹干活，对话、步骤、文件都挂在项目名下。";
  }
}

/**
 * 步骤刚完成时弹的提示：首行是结果，其余是下一步怎么做。next 为 null = 全部完成。
 */
export function completionNotice(
  completed: OnboardingStepId,
  next: OnboardingStepId | null,
  ctx: { installedLabel?: string | null } = {},
): { text: string; tone: "success" | "info" } {
  if (next === null) {
    return {
      text: "上手完成\n接下来可以在项目里开工，或随时点侧栏「新对话」。要再看这份引导，到顶栏「帮助」里找「上手引导」。",
      tone: "success",
    };
  }
  const headline = doneHeadline(completed, ctx);
  return { text: `${headline}\n${nextLine(next)}`, tone: "success" };
}

/** 第一段对话出现时弹的小提示（终端 + 标题合成一条）；两条都讲过（或已知）就不弹 */
export function tipsNotice(acks: OnboardingState["acks"]): string | null {
  const lines: string[] = [];
  if (!acks.terminal) {
    lines.push(
      "聊天底下跑的就是这家 Agent 的命令行（CLI），聊天和终端是同一段对话的两种画面：点运行页右上角的 >_ 图标看终端里 AI 实际运行的命令和完整输出，再点一次回到聊天，不会另开对话，也不会打断 AI。",
    );
  }
  if (!acks.naming) {
    lines.push(
      "对话标题由 AI 自动起，整理成「月日|类型|主题」，会用掉少量 token。想自己改：在侧栏右键这段对话选「重命名」，手改过的不会再被覆盖；不想自动起名：设置 → AI 与 Agent 里关掉「会话自动命名」。",
    );
  }
  return lines.length ? `两个小提示\n${lines.join("\n")}` : null;
}

/** 读本地存档；损坏或旧格式一律当没判定过（重新判定不会打扰老用户：有连接即收起）。旧存档里的网关 / 终端 / 标题确认键，
 *  终端和标题沿用为小提示的确认，其余丢弃 */
export function parseOnboarding(raw: string | null): OnboardingState {
  if (!raw) return { ...DEFAULT_ONBOARDING, acks: {} };
  try {
    const v = JSON.parse(raw) as Partial<OnboardingState>;
    const status: OnboardingStatus =
      v.status === "active" || v.status === "dismissed" || v.status === "done"
        ? v.status
        : "unset";
    const acks: OnboardingState["acks"] = {};
    if (v.acks && typeof v.acks === "object") {
      for (const id of ["terminal", "naming"] as const) {
        if ((v.acks as Record<string, unknown>)[id] === true) acks[id] = true;
      }
    }
    return { status, welcomed: v.welcomed === true, acks };
  } catch {
    return { ...DEFAULT_ONBOARDING, acks: {} };
  }
}

export function serializeOnboarding(state: OnboardingState): string {
  return JSON.stringify(state);
}
