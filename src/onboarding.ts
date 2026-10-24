/**
 * 上手引导（2026-10-20）的纯逻辑：步骤表、完成判定、进度、首次判定、提示文案与本地持久化。
 *
 * 完成状态一律由真实数据推导（装了哪家 Agent、有没有网关 / 连接 / 对话 / 项目），不另存
 * 「做到第几步」——用户跳着做、在别处做完、事后删掉，清单都如实反映。没有数据可推的靠确认（acks）：
 * 切到终端看（真切过一次或点「知道了」）、认识对话标题、用官方账号跳过网关。
 * 界面（侧栏行、清单浮层、欢迎页、连接页引导条、下一步提示）在 components/OnboardingGuide.tsx。
 */

export type OnboardingStepId =
  | "install"
  | "gateway"
  | "connection"
  | "chat"
  | "terminal"
  | "naming"
  | "project";

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
};

/** unset = 还没判定过；active = 引导进行中；dismissed = 用户收起或老用户；done = 全部完成 */
export type OnboardingStatus = "unset" | "active" | "dismissed" | "done";

export type OnboardingState = {
  status: OnboardingStatus;
  /** 欢迎页看过（关掉也算） */
  welcomed: boolean;
  acks: Partial<Record<OnboardingStepId, true>>;
};

export const ONBOARDING_STORAGE_KEY = "ccode.onboarding";

export const DEFAULT_ONBOARDING: OnboardingState = {
  status: "unset",
  welcomed: false,
  acks: {},
};

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  /** 一句话：这一步解决什么 */
  summary: string;
  /** 清单里展开后的做法，一段一件事 */
  how: string[];
};

/** 顺序即推荐顺序；「当前步」= 第一个没完成的 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: "install",
    title: "装一个 Agent",
    summary: "Mesa 本身不带 AI，它调度的是装在你电脑上的 AI 命令行工具（Agent）。",
    how: [
      "到「连接」页，任选一家点卡片上的「安装」；没有偏好就从 Claude Code 或 Codex 开始。",
      "安装要联网下载。在国内网络下载慢或失败，先到 设置 → 网络 填出网代理，再回来安装。",
    ],
  },
  {
    id: "gateway",
    title: "新建网关",
    summary: "网关是 AI 服务商给你的接口地址加一把 API Key。",
    how: [
      "打开网关库，点「+ 新建网关」：选服务商（地址和推荐模型自动填好），贴上密钥，点「测试」，通过后点「保存网关」。",
      "用官方订阅账号（Claude、ChatGPT 等）登录的不需要网关，点「我用官方账号」跳过，下一步添加连接时选「官方账号」。",
    ],
  },
  {
    id: "connection",
    title: "添加连接",
    summary: "连接决定哪个 Agent 用哪个网关、哪些模型。",
    how: [
      "在连接页点「+ 添加连接」，选「选用已有网关」，挑刚建的网关，勾上要用的模型（第一个是默认），保存。",
      "也可以在网关库里这个网关下方的「Agent 配置」直接添加，效果一样。",
    ],
  },
  {
    id: "chat",
    title: "开一段新对话",
    summary: "发一句话确认连接能用：有回复就是通的。",
    how: [
      "点侧栏「新对话」，在输入框写一句话发出去，例如「用三句话介绍你能帮我做什么」。",
      "报错时按提示回连接页改地址、密钥或模型；连接行上的对话图标可以直接用那条连接开聊。",
    ],
  },
  {
    id: "terminal",
    title: "切到终端看看",
    summary: "聊天和终端是同一段对话的两种画面：聊天是整理好的问答，终端是 AI 实际运行的命令行。",
    how: [
      "在运行页右上角点 >_ 图标（鼠标停上去写着「看这段对话的终端」）切到终端，看 AI 执行了哪些命令、完整输出是什么；再点一次回到聊天。也可以在输入框里打 /terminal。",
      "切换不会打断 AI，也不会另开一段对话。聊天里看不全、或想直接在命令行里操作时，切过去就行。",
    ],
  },
  {
    id: "naming",
    title: "认识对话标题",
    summary: "每段对话会被自动起一个标题，方便日后在「对话」页找回。",
    how: [
      "Mesa 先按你的第一个问题起临时标题，聊完再整理成「月日|类型|主题」，例如「1020|研究|梳理钙钛矿稳定性文献」。起名由 AI 完成，会用掉少量 token。",
      "想自己改：在「对话」页右键这段对话，选「编辑标题与标签」；在项目的「对话」页签里，鼠标停在对话上点铅笔图标。手改过的标题不会再被自动覆盖。",
      "不需要自动起名，到 设置 → AI 与 Agent 关掉「会话自动命名」。",
    ],
  },
  {
    id: "project",
    title: "建第一个项目",
    summary: "项目是 Mesa 的工作单位：一个课题一个文件夹，对话、步骤、文件都挂在它名下。",
    how: [
      "点「新建项目」，起名、选位置和工作方式（科研 / 编程 / 工作）。已经有课题文件夹，用「添加已有文件夹」登记。",
      "只想先看看科研流程长什么样，可以建一个示例课题。",
    ],
  },
];

export function stepById(id: OnboardingStepId): OnboardingStep {
  return ONBOARDING_STEPS.find((s) => s.id === id)!;
}

export function isStepDone(
  id: OnboardingStepId,
  facts: OnboardingFacts,
  state: OnboardingState,
): boolean {
  switch (id) {
    case "install":
      return facts.installedAgents.length > 0;
    case "gateway":
      // 已有连接说明接通了（官方账号不需要网关），不再要求补建
      return facts.gatewayCount > 0 || facts.profileCount > 0 || !!state.acks.gateway;
    case "connection":
      return facts.profileCount > 0;
    case "chat":
      return facts.userSessionCount > 0;
    case "terminal":
      return !!state.acks.terminal;
    case "naming":
      return !!state.acks.naming;
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

export function onboardingProgress(
  facts: OnboardingFacts,
  state: OnboardingState,
): OnboardingProgress {
  const steps = ONBOARDING_STEPS.map((step) => ({
    step,
    done: isStepDone(step.id, facts, state),
  }));
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
  return ONBOARDING_STEPS.map((s) => s.id).filter(
    (id) => next.includes(id) && !before.has(id),
  );
}

/**
 * 首次判定（只在 status 为 unset 时做一次，之后不再按数据回头改）：
 * 已有连接的是老用户，引导直接收起（不弹欢迎页、不占侧栏，帮助菜单可再打开）；
 * 其余当新用户。
 */
export function decideInitialStatus(facts: OnboardingFacts): "active" | "dismissed" {
  return facts.profileCount > 0 ? "dismissed" : "active";
}

/** 步骤完成时的结果句；网关有库里自己的「已保存」提示、终端与标题两步是人点的确认，不再重复 */
function doneHeadline(
  id: OnboardingStepId,
  ctx: { installedLabel?: string | null },
): string | null {
  switch (id) {
    case "install":
      return ctx.installedLabel ? `${ctx.installedLabel} 装好了` : "Agent 装好了";
    case "connection":
      return "连接已添加";
    case "chat":
      return "第一段对话开始了";
    case "project":
      return "项目建好了";
    default:
      return null;
  }
}

/** 「下一步」那一句；官方账号跳过网关时，添加连接要选「官方账号」 */
function nextLine(
  next: OnboardingStepId,
  ctx: { officialPath?: boolean },
): string {
  switch (next) {
    case "install":
      return "下一步：到连接页装一个 Agent，任选一家点「安装」。";
    case "gateway":
      return "下一步：新建网关。打开网关库，选服务商、贴密钥，测试通过后保存。";
    case "connection":
      return ctx.officialPath
        ? "下一步：添加连接。在连接页点「+ 添加连接」，账号类型选「官方账号」，再按提示登录。"
        : "下一步：添加连接。可以就在网关库这个网关下方的「Agent 配置」里选 Agent 和模型，也可以关掉网关库，在连接页点「+ 添加连接」。";
    case "chat":
      return "下一步：点侧栏「新对话」，发一句话试试连接通不通。";
    case "terminal":
      return "对话可以切到终端看\n在运行页右上角点 >_ 图标（鼠标停上去写着「看这段对话的终端」），就能看到 AI 实际运行的命令和完整输出；再点一次回到聊天，不会打断 AI。";
    case "naming":
      return "对话会自动起标题\n先按你的第一个问题起临时标题，聊完整理成「月日|类型|主题」。\n想自己改：在「对话」页右键它，选「编辑标题与标签」；手改过的不会再被覆盖。";
    case "project":
      return "下一步：建第一个项目。Mesa 围绕项目文件夹干活，对话、步骤、文件都挂在项目名下。";
  }
}

/**
 * 步骤刚完成时弹的提示：首行是结果（没有结果句就直接是下一步），其余是下一步怎么做。
 * next 为 null = 全部完成。
 */
export function completionNotice(
  completed: OnboardingStepId,
  next: OnboardingStepId | null,
  ctx: { installedLabel?: string | null; officialPath?: boolean } = {},
): { text: string; tone: "success" | "info" } {
  if (next === null) {
    return {
      text: "上手完成\n接下来可以在项目里开工，或随时点侧栏「新对话」。要再看这份引导，到顶栏「帮助」里找「上手引导」。",
      tone: "success",
    };
  }
  const headline = doneHeadline(completed, ctx);
  const line = nextLine(next, ctx);
  return headline
    ? { text: `${headline}\n${line}`, tone: "success" }
    : { text: line, tone: "info" };
}

/** 读本地存档；损坏或旧格式一律当没判定过（重新判定不会打扰老用户：有连接即收起） */
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
      for (const step of ONBOARDING_STEPS) {
        if ((v.acks as Record<string, unknown>)[step.id] === true) acks[step.id] = true;
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
