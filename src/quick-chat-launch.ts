/**
 * 「快速开聊」与「接着聊一段旧对话」的派发入口（侧栏、⌘K、工作台页头、顶部导航岛、对话页、项目区共用）。
 * 纯逻辑在 quick-chat.ts。
 *
 * 快速开聊＝新对话（2026-10-18 用户拍板，取代原弹层）：点了直接到一个空白聊天，Agent · 连接 · 模型 · 思考、权限、
 * 文件夹都在输入框里选，默认用上次快速开聊发第一句时的选择、文件夹默认「随手聊」（`~/ccode/scratch`）。
 * 还是发第一句才启动（2026-10-17 用户选定）。再点一次：有还没说过话的随手聊标签就切过去，聊过的不复用。
 * 刻意不做的事：不建项目、不建工作区、不写 `.ccode`、不注册、不选模板、不落 TASK.md；随手聊目录不 git init。
 */
import { invoke } from "@tauri-apps/api/core";
import { sessionRuntimeKey, useAppStore } from "./store";
import { AGENTS, type RunDto, type SessionMetaDto } from "./types";
import { confirmDialog } from "./components/ConfirmDialog";
import {
  QUICK_CHAT_KEY_PREFIX,
  pickQuickChatDefault,
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

/** 开一个空白随手聊（或切到还没说过话的那个）。随手聊目录建不出来时退回主目录，不拦着人开聊 */
export async function openQuickChat(): Promise<void> {
  const { profiles, settings, agents, setPendingTerminal, setPage } = useAppStore.getState();
  for (const key of RETIRED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }
  const hidden = new Set(settings?.hiddenProfiles ?? []);
  const agentOrder = AGENTS.map((a) => a.id);
  const installedSet = new Set((agents ?? []).filter((a) => a.binaryPath).map((a) => a.id));
  const pick = pickQuickChatDefault({
    remembered: loadChoice(),
    lastLaunch: loadLastLaunch(),
    usable: (profiles ?? [])
      .filter((p) => profileCanAutoStart(p, hidden.has(p.id)))
      .map((p) => ({ id: p.id, agent: p.agent, models: p.models })),
    installed: agentOrder.filter((id) => installedSet.has(id)),
    agentOrder,
  });
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
  });
  setPage("terminal");
}

/** 恢复一条历史会话进终端（聊天空态的随手聊列表、侧栏右键、项目区「继续」、对话页共用）：不开新会话。
    cwd 用会话原目录——worktree 会话的 projectPath 已归并回真实仓库（展示层另有工作区标注）。
    终端里已经在跑这条会话时只切过去，不重复 resume。
    reuseKey 按会话 id：同一对话重复点切回同一标签；终端页消费处另有 runId/会话身份兜底
    （进程活着时不重复 resume，防 active writer 冲突）。
    这条会话正在 Mesa 以外的终端里跑（iTerm / Ghostty 里直接敲的 claude，会话文件一分钟内还在写）时先确认：
    两个进程接着同一段对话会把记录写乱（2026-10-17 用户问在外部终端用 Agent CLI 要完善什么）。
    Run 身份（runId/taskId/profileId）先查齐再一次性派发——先派发再补写会被终端页
    即时消费掉，补写条件不再成立，同一会话分裂成新 Run。
    onOpened：已切到 / 已派发之后回调；用户在确认框里取消时调 onSkipped */
export function resumeSessionInTerminal(
  s: SessionMetaDto,
  opts?: {
    preferredProfileId?: string | null;
    onOpened?: () => void;
    onSkipped?: () => void;
  },
): void {
  const { setPendingTerminal, setPage, liveSessions, focusTab } = useAppStore.getState();
  const liveTab = liveSessions[sessionRuntimeKey(s.agent, s.sessionId)];
  if (liveTab) {
    setPage("terminal");
    focusTab(liveTab);
    opts?.onOpened?.();
    return;
  }
  const preferred = opts?.preferredProfileId?.trim() || "";
  void (async () => {
    if (s.live) {
      const ok = await confirmDialog(
        "这段对话可能正在别的终端里运行\n\n它的记录在最近一分钟里还有写入，而 Mesa 里没有打开它——多半是你在 iTerm、Ghostty 这类终端里直接运行的。两边同时接着聊，两份回复会交错写进同一段记录。\n\n建议先在那个终端里退出（Claude Code 按两次 Ctrl+C），再回来点继续。如果那边刚刚已经退出，可以直接继续。",
        { confirmText: "仍在 Mesa 里继续", focusCancel: true },
      );
      if (!ok) {
        opts?.onSkipped?.();
        return;
      }
    }
    const run = await invoke<RunDto | null>("run_find", {
      reuseKey: null,
      agent: s.agent,
      sessionId: s.sessionId,
    }).catch(() => null);
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
      // 项目绑了这家配置就预填它；Codex 渠道和上次不同时启动栏仍显示绑定、不自动跑。
      // 没绑才回落原 Run 的配置。
      profileId: preferred ? undefined : (run?.profileId ?? undefined),
      autoLaunchProfileId: preferred || undefined,
    });
    setPage("terminal");
    opts?.onOpened?.();
  })();
}
