/**
 * 「快速开聊」与「接着聊一段旧对话」的派发入口（侧栏、⌘K、顶部导航岛、侧栏项目树、工作台、对话页共用）。
 * 纯逻辑在 quick-chat.ts。
 *
 * 快速开聊＝新对话（2026-10-18 用户拍板，取代原弹层）：点了直接到一个空白聊天，Agent · 连接 · 模型 · 思考、权限、
 * 文件夹都在输入框里选，默认用上次快速开聊发第一句时的选择、文件夹默认「随手聊」（`~/ccode/scratch`）。
 * 还是发第一句才启动（2026-10-17 用户选定）。再点一次：有还没说过话的随手聊标签就切过去，聊过的不复用。
 * 刻意不做的事：不建项目、不建工作区、不写 `.ccode`、不注册、不选模板、不落 TASK.md；随手聊目录不 git init。
 */
import { invoke } from "@tauri-apps/api/core";
import { sessionRuntimeKey, useAppStore } from "./store";
import { AGENTS, type ConversationPageDto, type ProjectDto, type RunDto, type SessionMetaDto } from "./types";
import {
  OneShotPrefetch,
  PAGE_CACHE_LIMIT,
  RESUME_LOOKUP_TTL_MS,
  VersionedCache,
} from "./conversation-prefetch";
import { projectChatLaunch, sessionProjectResumeProfileId } from "./project-agents";
import { IS_WINDOWS } from "./hotkeys";
import { normalizeWorkMode, projectChatReuseKey } from "./work-mode";
import { confirmDialog } from "./components/ConfirmDialog";
import { lastWriteIsMesas, resumeModelChoice, resumeProfileChoice } from "./terminal-resume";
import {
  QUICK_CHAT_KEY_PREFIX,
  pickQuickChatDefault,
  chatChoiceForProfile,
  profileCanAutoStart,
  sessionDisplayTitle,
  type QuickChatChoice,
} from "./quick-chat";

const CHOICE_KEY = "ccode.quickChat";
/** 原弹层「每次都先问我」的两个键：弹层没了，打开快速开聊时顺手清掉 */
const RETIRED_KEYS = ["ccode.quickChatAlwaysAsk", "ccode.quickChatSkip"];

function loadChoice(): QuickChatChoice {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "{}");
    return typeof v === "object" && v !== null ? (v as QuickChatChoice) : {};
  } catch {
    return {};
  }
}

/** 快速开聊标签发出第一句、Agent 起来之后记下这次的选择（TerminalView launch 调）：下次快速开聊照它开。
 *  不记文件夹（每次都从「随手聊」开始）和权限（完全访问每次都要人确认） */
export function saveQuickChatChoice(choice: QuickChatChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    /* 隐私模式写不进就算了 */
  }
}

function loadLastLaunch(): { agentId?: string; profileId?: string } {
  try {
    const v: unknown = JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}");
    return typeof v === "object" && v !== null ? (v as { agentId?: string; profileId?: string }) : {};
  } catch {
    return {};
  }
}

/** 开一个空白随手聊标签（落到聊天层，文件夹「随手聊」，发第一句才启动）。
 *  随手聊目录建不出来时退回主目录，不拦着人开聊。
 *  reseedBlank：已有还没说过话的随手聊标签时，是否把它的输入框改成 pick（快速开聊不改、连接页点名要连接才改） */
async function openBlankChat(
  pick: QuickChatChoice & { agentId: string },
  reseedBlank: boolean,
): Promise<void> {
  const { setPendingTerminal, setPage } = useAppStore.getState();
  const cwd = await invoke<string>("ensure_scratch_dir").catch(() => "~");
  setPendingTerminal({
    cwd,
    extraEnv: {},
    title: "随手聊",
    agentId: pick.agentId,
    profileId: pick.profileId,
    model: pick.model,
    effort: pick.effort ?? null,
    autoStart: false,
    surface: "chat",
    clean: true,
    // 每个随手聊标签一把自己的复用键（后端按它认 Run）；再点快速开聊按前缀找还没说过话的那个
    reuseKey: `${QUICK_CHAT_KEY_PREFIX}${crypto.randomUUID()}`,
    reuseBlank: QUICK_CHAT_KEY_PREFIX,
    reseedBlank,
  });
  setPage("terminal");
}

/** 快速开聊默认用谁（pickQuickChatDefault）；项目里开新对话、项目没设默认时也退回它 */
function quickChatDefaultPick(): QuickChatChoice & { agentId: string } {
  const { profiles, settings, agents } = useAppStore.getState();
  const hidden = new Set(settings?.hiddenProfiles ?? []);
  const agentOrder = AGENTS.map((a) => a.id);
  const installedSet = new Set((agents ?? []).filter((a) => a.binaryPath).map((a) => a.id));
  return pickQuickChatDefault({
    remembered: loadChoice(),
    lastLaunch: loadLastLaunch(),
    usable: (profiles ?? [])
      .filter((p) => profileCanAutoStart(p, hidden.has(p.id)))
      .map((p) => ({ id: p.id, agent: p.agent, models: p.models })),
    installed: agentOrder.filter((id) => installedSet.has(id)),
    agentOrder,
  });
}

/** 开一个空白随手聊（或切到还没说过话的那个）。选谁见 pickQuickChatDefault */
export async function openQuickChat(): Promise<void> {
  for (const key of RETIRED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }
  await openBlankChat(quickChatDefaultPick(), false);
}

/** 在某个项目里开一段新对话（侧栏项目行 ＋、项目页「＋ 新对话」）。2026-10-24 用户：点了 ＋ 不该自己开跑——
 *  原先带着项目说明当第一句直接启动，Agent 不等人开口就开始翻项目；同一项目再点 ＋ 还会切回旧标签、把说明再发一遍。
 *  现在和快速开聊一样：空白输入框，文件夹就是这个项目，用谁按项目「对话」槽 > 项目默认（projectChatLaunch），
 *  都没设退回快速开聊的默认；发第一句才启动，项目说明（项目设置里的对话注入）由 TerminalView 发第一句时附在前面。
 *  每次都是新对话：只复用这个项目里还没说过话的那个 */
export function openProjectChat(project: ProjectDto): void {
  const mode = normalizeWorkMode(project.workMode);
  const kind = mode === "coding" || mode === "office" ? mode : "research";
  const { profiles, setPendingTerminal, setPage } = useAppStore.getState();
  const pick = projectChatLaunch(profiles, project) ?? quickChatDefaultPick();
  const prefix = `${projectChatReuseKey(kind, project.path)}:`;
  setPendingTerminal({
    cwd: project.path,
    extraEnv: {},
    title: project.name,
    agentId: pick.agentId,
    profileId: pick.profileId,
    model: pick.model,
    effort: "effort" in pick ? (pick.effort ?? null) : null,
    autoStart: false,
    surface: "chat",
    reuseKey: `${prefix}${crypto.randomUUID()}`,
    reuseBlank: prefix,
  });
  setPage("terminal");
}

/** 连接页「新对话」：用点的这条连接开空白对话，输入框里写着的就是它，发一句话看有没有回复，用来快速检查连接可不可用。
 *  不看「记住的」默认，也不预先挡不可用的连接（缺端点 / 缺密钥 / 已停用都照样打开，问题由输入框和启动提示如实说出来）；
 *  已有空白随手聊标签时复用它但把选择改成这条（不然会落在选着别的连接的标签上，检查就白做了） */
export async function openChatWithProfile(profile: {
  id: string;
  agent: string;
  models?: readonly string[] | null;
}): Promise<void> {
  await openBlankChat(chatChoiceForProfile(profile), true);
}

type ResumeLookup = {
  run: RunDto | null;
  config: { model: string | null; effort: string | null } | null;
  /** 调用方没给项目连接预填时按会话目录现找（工作台「最近对话」、对话页「继续」不知道项目） */
  projects: ProjectDto[];
};
// 点开对话前要等的两样东西与摆出来的记录页，鼠标移上去就先取（conversation-prefetch.ts）
const resumeLookups = new OneShotPrefetch<ResumeLookup>(RESUME_LOOKUP_TTL_MS);
const conversationPages = new VersionedCache<ConversationPageDto>(PAGE_CACHE_LIMIT);

function resumeLookupKey(s: SessionMetaDto): string {
  return `${s.agent}\n${s.sessionId}`;
}

async function fetchResumeLookup(s: SessionMetaDto): Promise<ResumeLookup> {
  const [run, config, projects] = await Promise.all([
    invoke<RunDto | null>("run_find", {
      reuseKey: null,
      agent: s.agent,
      sessionId: s.sessionId,
    }).catch(() => null),
    invoke<{ model: string | null; effort: string | null }>("session_resume_config", {
      agent: s.agent,
      sessionId: s.sessionId,
      filePath: s.filePath,
    }).catch(() => null),
    invoke<ProjectDto[]>("list_projects").catch(() => []),
  ]);
  return { run, config, projects };
}

/** 只看不接的标签摆出来的最近一页记录：会话更新时间没变就复用上次读的（version 传 updatedAt） */
export function conversationPageFor(
  agent: string,
  filePath: string,
  version: string,
): Promise<ConversationPageDto> {
  return conversationPages.get(`${agent}\n${filePath}`, version, () =>
    invoke<ConversationPageDto>("get_session_conversation_page", {
      agent,
      filePath,
      before: null,
      around: null,
    }),
  );
}

/** 鼠标移到列表里的一段对话上：先把点开要等的东西取回来。Mesa 里已经开着它的不用取（点了只是切过去） */
export function prefetchConversation(s: SessionMetaDto): void {
  if (!s.alive) return;
  const { liveSessions, terminalRunInputs } = useAppStore.getState();
  if (
    liveSessions[sessionRuntimeKey(s.agent, s.sessionId)] ||
    terminalRunInputs.some((r) => r.agentId === s.agent && r.sessionId === s.sessionId)
  ) {
    return;
  }
  resumeLookups.prefetch(resumeLookupKey(s), () => fetchResumeLookup(s));
  void conversationPageFor(s.agent, s.filePath, s.updatedAt ?? "").catch(() => {});
}

/** 列表里点一段对话（侧栏项目树、工作台「最近对话」、对话页「继续」，2026-10-23 侧栏挂对话第一期）：
 *  进运行页这段对话，记录先摆出来、能直接写，发第一句才接回（只看不起进程）。
 *  源文件已经不在的接不回，去对话页看保留下来的快照。 */
export function openConversation(
  s: SessionMetaDto,
  opts?: { preferredProfileId?: string | null; split?: boolean },
): void {
  if (!s.alive) {
    const { setOpenSessionReq, setPage } = useAppStore.getState();
    setOpenSessionReq({ agent: s.agent, sessionId: s.sessionId });
    setPage("sessions");
    return;
  }
  resumeSessionInTerminal(s, {
    preferredProfileId: opts?.preferredProfileId,
    lazy: true,
    split: opts?.split,
  });
}

/** 恢复一条历史会话进终端（列表点对话经 openConversation 走 lazy；其余入口直接接回）：不开新会话。
    cwd 用会话原目录——worktree 会话的 projectPath 已归并回真实仓库（展示层另有工作区标注）。
    Mesa 里已经有标签持着这条会话（在跑的、只看没接的、还没登记完的都算）时只切过去，不重复 resume。
    reuseKey 按会话 id：同一对话重复点切回同一标签；终端页消费处另有 runId/会话身份兜底
    （进程活着时不重复 resume，防 active writer 冲突）。
    这条会话正在 Mesa 以外的终端里跑（iTerm / Ghostty 里直接敲的 claude，会话文件一分钟内还在写）时先确认：
    两个进程接着同一段对话会把记录写乱（2026-10-17 用户问在外部终端用 Agent CLI 要完善什么）。
    最后那笔是 Mesa 自己刚停掉的进程写的不算（lastWriteIsMesas，2026-10-24 误报实证）。
    连接 / 模型 / 思考档默认用这段对话上次的（resumeProfileChoice + session_resume_config，2026-10-24 用户）。
    Run 身份（runId/taskId/profileId）先查齐再一次性派发——先派发再补写会被终端页
    即时消费掉，补写条件不再成立，同一会话分裂成新 Run。
    onOpened：已切到 / 已派发之后回调；用户在确认框里取消时调 onSkipped。
    lazy：只打开、不起进程，发第一句才接回（见 openConversation）；split：放到右侧分屏，正看着的那段留在左边 */
export function resumeSessionInTerminal(
  s: SessionMetaDto,
  opts?: {
    preferredProfileId?: string | null;
    onOpened?: () => void;
    onSkipped?: () => void;
    lazy?: boolean;
    split?: boolean;
  },
): void {
  const { setPendingTerminal, setPage, liveSessions, focusTab, terminalRunInputs } =
    useAppStore.getState();
  const holder =
    liveSessions[sessionRuntimeKey(s.agent, s.sessionId)] ??
    terminalRunInputs.find((r) => r.agentId === s.agent && r.sessionId === s.sessionId)?.tabId;
  if (holder && !opts?.split) {
    setPage("terminal");
    focusTab(holder);
    opts?.onOpened?.();
    return;
  }
  void (async () => {
    const { run, config, projects } = await resumeLookups.take(resumeLookupKey(s), () => fetchResumeLookup(s));
    if (s.live && !holder && !lastWriteIsMesas(s.updatedAt, run)) {
      const ok = await confirmDialog(
        "这段对话可能正在别的终端里运行\n\n它的记录在最近一分钟里还有写入，而 Mesa 里没有打开它——多半是你在 iTerm、Ghostty 这类终端里直接运行的。两边同时接着聊，两份回复会交错写进同一段记录。\n\n建议先在那个终端里退出（Claude Code 按两次 Ctrl+C），再回来点继续。如果那边刚刚已经退出，可以直接继续。",
        { confirmText: "仍在 Mesa 里继续", focusCancel: true },
      );
      if (!ok) {
        opts?.onSkipped?.();
        return;
      }
    }
    const { profiles, settings } = useAppStore.getState();
    const choice = resumeProfileChoice({
      agentId: s.agent,
      own: s.profileId ?? run?.profileId,
      // 侧栏给了就用侧栏的；别的入口按这段对话所属的项目补，同一段对话从哪儿点开都一样
      preferred:
        opts?.preferredProfileId ??
        sessionProjectResumeProfileId(profiles, projects, s, IS_WINDOWS),
      profiles,
      hidden: settings?.hiddenProfiles,
    });
    const chosen = profiles.find((p) => p.id === (choice.profileId ?? choice.autoLaunchProfileId));
    setPendingTerminal({
      cwd: s.cwd ?? s.projectPath,
      extraEnv: {},
      title: sessionDisplayTitle(s),
      resume: {
        agentId: s.agent,
        sessionId: s.sessionId,
        provider: s.provider,
      },
      reuseKey: `resume:${s.agent}:${s.sessionId}`,
      runId: run?.id,
      taskId: run?.taskId || undefined,
      ...choice,
      model: resumeModelChoice(config?.model, chosen),
      effort: config?.effort?.trim() || null,
      resumeLazy: opts?.lazy || undefined,
      split: opts?.split || undefined,
    });
    setPage("terminal");
    opts?.onOpened?.();
  })();
}
