import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, X } from "lucide-react";
import { useAppStore } from "../store";
import { openQuickChat } from "../quick-chat-launch";
import { dismissToast, toast, type ToastAction } from "../toast";
import { AGENTS } from "../types";
import {
  completionNotice,
  decideInitialStatus,
  doneStepIds,
  newlyDone,
  onboardingProgress,
  stepById,
  type OnboardingFacts,
  type OnboardingStepId,
} from "../onboarding";
import { Modal } from "./Modal";
import {
  compactPrimaryActionClass,
  ghostActionClass,
  primaryActionClass,
  quietActionClass,
  rowActionClass,
} from "./PageFrame";

/**
 * 上手引导的界面（2026-10-20）。形态：欢迎页只在新装时弹一次；之后由侧栏「上手引导」行
 * 记进度、点开是清单浮层；连接页顶上有当前这一步的引导条；每做完一步右下角提示下一步。
 * 不做聚光灯遮罩式导览——步骤散在好几页、安装要等几分钟，遮罩一离开路线就失效。
 * 完成判定与文案在 onboarding.ts。
 */

/** 「下一步」提示共用一个 key：新的一条顶掉旧的，收起引导时一并撤掉 */
const TOAST_KEY = "onboarding";

const labelOf = (agentId: string | undefined) =>
  agentId ? (AGENTS.find((a) => a.id === agentId)?.label ?? agentId) : null;

/** 由 store 里已有的数据现算；agents 为空 = 连接数据还没到，不判定 */
export function useOnboardingFacts(): OnboardingFacts | null {
  const agents = useAppStore((s) => s.agents);
  const gatewayCount = useAppStore((s) => s.gateways.length);
  const profileCount = useAppStore((s) => s.profiles.length);
  // 取引用、在 memo 里数：选择器里现数会在每次 store 更新时把整份会话表扫一遍
  const sessions = useAppStore((s) => s.sessions);
  const projectCount = useAppStore((s) => s.projectPaths.length);
  return useMemo(() => {
    if (agents.length === 0) return null;
    const installed = new Set(agents.filter((a) => a.binaryPath).map((a) => a.id));
    return {
      installedAgents: AGENTS.map((a) => a.id as string).filter((id) => installed.has(id)),
      gatewayCount,
      profileCount,
      userSessionCount: sessions.filter((session) => !session.internal).length,
      projectCount,
    };
  }, [agents, gatewayCount, profileCount, sessions, projectCount]);
}

/** 帮助菜单 / 命令面板「上手引导」：收起过的重新打开，然后弹出清单 */
export function openOnboardingGuide() {
  const s = useAppStore.getState();
  if (s.onboarding.status === "dismissed" || s.onboarding.status === "unset") {
    s.updateOnboarding({ status: "active", welcomed: true });
  }
  s.setOnboardingPanelOpen(true);
}

function ack(id: OnboardingStepId) {
  useAppStore.getState().ackOnboarding(id);
}

type StepAction = {
  label: string;
  run: () => void;
  primary?: boolean;
  /** 点完清单不收起（确认类动作：做完要接着看下一步） */
  keepOpen?: boolean;
  /** 只是「去连接页」：人已经在连接页时不显示 */
  toProfiles?: boolean;
};

/** 每一步能直接点的动作；第一个是主动作。清单、欢迎页、下一步提示、连接页引导条共用 */
function stepActions(id: OnboardingStepId, facts: OnboardingFacts): StepAction[] {
  const s = () => useAppStore.getState();
  switch (id) {
    case "install":
      return [
        { label: "去连接页安装", primary: true, toProfiles: true, run: () => s().setPage("profiles") },
        {
          label: "设置出网代理",
          run: () => {
            s().setSettingsSectionReq("network");
            s().setPage("settings");
          },
        },
      ];
    case "gateway":
      return [
        {
          label: "打开网关库",
          primary: true,
          run: () => {
            s().setPage("profiles");
            s().setGatewayLibraryReq({ token: Date.now(), create: facts.gatewayCount === 0 });
          },
        },
        ...(facts.gatewayCount === 0 && facts.profileCount === 0
          ? [{ label: "我用官方账号，跳过", keepOpen: true, run: () => ack("gateway") }]
          : []),
      ];
    case "connection":
      return [
        {
          label: "添加连接",
          primary: true,
          run: () => {
            s().setPage("profiles");
            s().setProfileModalReq(Date.now());
          },
        },
      ];
    case "chat":
      return [{ label: "新对话", primary: true, run: () => void openQuickChat() }];
    case "terminal":
      return [
        {
          label: "切到终端",
          primary: true,
          run: () => {
            ack("terminal");
            s().setPage("terminal");
            s().setSurfaceSwitchReq({ mode: "terminal", token: Date.now() });
          },
        },
        { label: "知道了", keepOpen: true, run: () => ack("terminal") },
      ];
    case "naming":
      return [
        { label: "知道了", primary: true, keepOpen: true, run: () => ack("naming") },
        {
          label: "去对话页看看",
          run: () => {
            ack("naming");
            s().setPage("sessions");
          },
        },
      ];
    case "project":
      return [
        {
          label: "新建项目",
          primary: true,
          run: () => {
            s().setPage("workspaces");
            s().setNewProjectOpenReq({ token: Date.now() });
          },
        },
        {
          label: "添加已有文件夹",
          run: () => {
            s().setPage("workspaces");
            s().setAddProjectOpenReq(Date.now());
          },
        },
        {
          label: "建示例课题",
          run: () => {
            s().setPage("workspaces");
            s().setDemoProjectOpenReq(Date.now());
          },
        },
      ];
  }
}

/** 官方账号跳过了网关、还没建网关：添加连接要选「官方账号」 */
function isOfficialPath(facts: OnboardingFacts, acks: Partial<Record<OnboardingStepId, true>>) {
  return !!acks.gateway && facts.gatewayCount === 0;
}

/** 进度环：底圈 field 色、完成段品牌色（与上下文圆环同一画法） */
export function OnboardingRing({
  done,
  total,
  size = 16,
}: {
  done: number;
  total: number;
  size?: number;
}) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0 text-cta"
    >
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-field)" strokeWidth="2" />
      {ratio > 0 && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${c * ratio} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

/** 步骤序号圈：做完 = 绿勾；当前 = 品牌色描边；其余 = 淡描边 */
function StepMark({ done, current, index }: { done: boolean; current: boolean; index: number }) {
  if (done) {
    return (
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ok text-ok-text">
        <Check size={11} strokeWidth={2.6} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border text-micro tabular-nums ${
        current ? "border-cta font-medium text-l1" : "border-field text-l4"
      }`}
    >
      {index}
    </span>
  );
}

/** 侧栏「上手引导」行的数据：引导进行中才有 */
export function useOnboardingRail(): {
  done: number;
  total: number;
  next: string | null;
  open: boolean;
} | null {
  const facts = useOnboardingFacts();
  const state = useAppStore((s) => s.onboarding);
  const open = useAppStore((s) => s.onboardingPanelOpen);
  if (!facts || state.status !== "active") return null;
  const progress = onboardingProgress(facts, state);
  return {
    done: progress.doneCount,
    total: progress.total,
    next: progress.current ? stepById(progress.current).title : null,
    open,
  };
}

/**
 * 挂在 App 根部：首次判定、步骤完成后的「下一步」提示、欢迎页与清单浮层。
 * ready = 首屏数据（连接 / 会话 / 项目）都到齐了——没到齐时判定会把老用户当新人、
 * 把陆续到达的数据当成「刚做完」。
 */
export function OnboardingHost({ ready }: { ready: boolean }) {
  const facts = useOnboardingFacts();
  const state = useAppStore((s) => s.onboarding);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);

  useEffect(() => {
    if (!ready || !facts || state.status !== "unset") return;
    const status = decideInitialStatus(facts);
    updateOnboarding({ status, welcomed: status !== "active" });
  }, [ready, facts, state.status, updateOnboarding]);

  const prevDone = useRef<OnboardingStepId[] | null>(null);
  useEffect(() => {
    if (!ready || !facts) return;
    const progress = onboardingProgress(facts, state);
    const done = doneStepIds(progress);
    const prev = prevDone.current;
    prevDone.current = done;
    // 第一次只记基线；引导没在进行时做完的步骤不提示
    if (!prev || state.status !== "active") return;
    const fresh = newlyDone(prev, done);
    if (!fresh.length) return;
    const officialPath = isOfficialPath(facts, state.acks);
    const notice = completionNotice(fresh[fresh.length - 1]!, progress.current, {
      installedLabel: labelOf(facts.installedAgents[0]),
      officialPath,
    });
    if (progress.current === null) {
      dismissToast(TOAST_KEY);
      toast(notice.text, "success");
      updateOnboarding({ status: "done" });
      return;
    }
    const actions: ToastAction[] = stepActions(progress.current, facts)
      .slice(0, 2)
      .map((a) => ({ label: a.label, onClick: a.run, primary: a.primary }));
    toast(notice.text, notice.tone, { key: TOAST_KEY, sticky: true, actions });
  }, [ready, facts, state, updateOnboarding]);

  // 收起或完成后，残留的「下一步」提示一并撤掉
  useEffect(() => {
    if (state.status !== "active") dismissToast(TOAST_KEY);
  }, [state.status]);

  if (!facts) return null;
  return (
    <>
      <OnboardingWelcome facts={facts} />
      <OnboardingPanel facts={facts} />
    </>
  );
}

/** 新装后第一次打开：一页说清楚要走哪几步，主按钮直接去做当前这一步 */
function OnboardingWelcome({ facts }: { facts: OnboardingFacts }) {
  const state = useAppStore((s) => s.onboarding);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const open = state.status === "active" && !state.welcomed;
  const progress = onboardingProgress(facts, state);
  const current = progress.current;
  const close = () => updateOnboarding({ welcomed: true });
  const start = () => {
    close();
    if (current) stepActions(current, facts).find((a) => a.primary)?.run();
  };
  return (
    <Modal
      open={open}
      title="欢迎使用 Mesa"
      description="AI 科研工作台：AI 负责干活，Mesa 负责管活，你负责拍板。"
      onClose={close}
      size="md"
      footer={
        <>
          <button type="button" className={quietActionClass} onClick={close}>
            先自己看看
          </button>
          <button type="button" className={primaryActionClass} onClick={start}>
            {current ? `开始：${stepById(current).title}` : "开始使用"}
          </button>
        </>
      }
    >
      <p className="text-sm leading-6 text-l2">第一次用，先花几分钟把 AI 接上，照下面几步走：</p>
      <ol className="mt-3 space-y-2.5">
        {progress.steps.map(({ step, done }, i) => (
          <li key={step.id} className="flex gap-2.5">
            <StepMark done={done} current={step.id === current} index={i + 1} />
            <span className="min-w-0">
              <span className={`block text-sm ${done ? "text-l3" : "text-l1"}`}>{step.title}</span>
              <span className="block text-xs leading-5 text-l3">{step.summary}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs leading-5 text-l3">
        {chromeHidden
          ? "顶栏「帮助」里的「上手引导」记着进度，随时点开看下一步；做完的步骤会自动打勾。"
          : "左侧栏下方的「上手引导」记着进度，随时点开看下一步；做完的步骤会自动打勾。"}
      </p>
    </Modal>
  );
}

/** 清单浮层：贴着侧栏「上手引导」行向右展开；侧栏收起（全隐藏）时挂在顶栏帮助下方 */
function OnboardingPanel({ facts }: { facts: OnboardingFacts }) {
  const open = useAppStore((s) => s.onboardingPanelOpen);
  const setOpen = useAppStore((s) => s.setOnboardingPanelOpen);
  const state = useAppStore((s) => s.onboarding);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);
  const progress = onboardingProgress(facts, state);
  const [expanded, setExpanded] = useState<OnboardingStepId | null>(progress.current);
  // 每次打开、以及做完一步：展开当前步
  useEffect(() => {
    setExpanded(progress.current);
  }, [progress.current, open]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = document.querySelector<HTMLElement>("[data-onboarding-anchor]");
      const rect = anchor?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        setPos({
          left: rect.right + 8,
          bottom: Math.max(8, window.innerHeight - rect.bottom),
          maxHeight: Math.max(240, rect.bottom - 48),
        });
      } else {
        setPos({ top: 44, right: 12, maxHeight: window.innerHeight - 56 });
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Esc / 点浮层外关闭；点侧栏那一行交给它自己切换
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (target.closest?.("[data-onboarding-anchor]")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, setOpen]);

  if (!open) return null;
  const allDone = progress.current === null;
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="上手引导"
      style={pos}
      className="ccode-float-surface fixed z-50 flex w-[22rem] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-field"
    >
      <div className="shrink-0 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-l1">上手引导</h2>
          <span className="text-micro tabular-nums text-l3">
            {progress.doneCount}/{progress.total}
          </span>
          <button
            type="button"
            aria-label="关闭"
            title="关闭（Esc）"
            className="-mr-1.5 ml-auto flex h-7 w-7 items-center justify-center rounded-md text-l3 transition-colors hover:bg-hover hover:text-l1"
            onClick={() => setOpen(false)}
          >
            <X size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <p className="mt-0.5 text-xs leading-5 text-l3">
          {allDone
            ? "都做完了。每一步还能点开回看做法。"
            : "几分钟接上 AI、跑通第一段对话。做完的步骤会自动打勾。"}
        </p>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-hairline">
          <div
            className="h-full rounded-full bg-cta transition-[width] duration-300"
            style={{ width: `${(progress.doneCount / progress.total) * 100}%` }}
          />
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {progress.steps.map(({ step, done }, i) => {
          const isOpen = expanded === step.id;
          const isCurrent = progress.current === step.id;
          return (
            <li key={step.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : step.id)}
                className="flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
              >
                <StepMark done={done} current={isCurrent} index={i + 1} />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    isCurrent ? "font-medium text-l1" : done ? "text-l3" : "text-l2"
                  }`}
                >
                  {step.title}
                </span>
              </button>
              {isOpen && (
                <div className="pb-3 pl-[2.375rem] pr-2">
                  <p className="text-xs leading-5 text-l2">{step.summary}</p>
                  {step.how.map((line) => (
                    <p key={line} className="mt-1 text-xs leading-5 text-l3">
                      {line}
                    </p>
                  ))}
                  <div className="mt-2.5 flex flex-wrap gap-1.5 text-xs">
                    {stepActions(step.id, facts).map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className={
                          action.primary
                            ? compactPrimaryActionClass
                            : action.keepOpen
                              ? ghostActionClass
                              : rowActionClass
                        }
                        onClick={() => {
                          if (!action.keepOpen) setOpen(false);
                          action.run();
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-2 text-xs">
        {state.status === "active" && (
          <button
            type="button"
            className="text-xs text-l3 transition-colors hover:text-l1"
            onClick={() => {
              updateOnboarding({ status: "dismissed" });
              setOpen(false);
            }}
          >
            不再显示引导
          </button>
        )}
        <span className="ml-auto text-micro text-l4">顶栏「帮助」里可以再打开</span>
      </div>
    </div>
  );
}

/** 连接页引导条在每一步写什么（只覆盖在连接页上做的几步） */
function stripText(id: OnboardingStepId, officialPath: boolean): string | null {
  switch (id) {
    case "install":
      return "在下面任选一家点「安装」，没有偏好就从 Claude Code 或 Codex 开始。安装要联网下载，在国内网络慢或失败时，先填出网代理再装。";
    case "gateway":
      return "点右上「网关库」→「+ 新建网关」：选端点预设、贴 API Key，测试通过后保存。用官方订阅账号登录的，可以跳过这一步。";
    case "connection":
      return officialPath
        ? "点右上「+ 添加连接」，账号类型选「官方账号」，保存后在这家 Agent 卡片上点「登录」，按终端提示完成。"
        : "点右上「+ 添加连接」，选「选用已有网关」，挑刚建的网关和要用的模型，保存。";
    case "chat":
      return "连接加好了。点侧栏「新对话」发一句话，有回复就是通的。";
    default:
      return null;
  }
}

/** 连接页顶上的引导条：当前这一步在本页怎么做。页头已有主按钮，这里的按钮一律用次级样式 */
export function OnboardingPageStrip() {
  const facts = useOnboardingFacts();
  const state = useAppStore((s) => s.onboarding);
  // 收起只管本次运行里的这一步；走到下一步自然再出现
  const [hiddenStep, setHiddenStep] = useState<OnboardingStepId | null>(null);
  if (!facts || state.status !== "active") return null;
  const progress = onboardingProgress(facts, state);
  const current = progress.current;
  if (!current || current === hiddenStep) return null;
  const officialPath = isOfficialPath(facts, state.acks);
  const text = stripText(current, officialPath);
  if (!text) return null;
  const index = progress.steps.findIndex((s) => s.step.id === current) + 1;
  const actions = stepActions(current, facts).filter((a) => !a.toProfiles);
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-lg ccode-well px-3.5 py-3">
      <span className="mt-0.5">
        <OnboardingRing done={progress.doneCount} total={progress.total} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-l1">
          上手第 {index} 步 · {stepById(current).title}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-l3">{text}</p>
        {actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={action.keepOpen ? ghostActionClass : rowActionClass}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="收起这条提示"
        title="收起这条提示（侧栏「上手引导」里仍能看到）"
        className="-mr-1 -mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 transition-colors hover:bg-hover hover:text-l1"
        onClick={() => setHiddenStep(current)}
      >
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
