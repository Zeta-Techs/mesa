import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronUp,
  Copy,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useAppStore } from "../store";
import { useExitRender } from "../exit-animation";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { macOverlayPadClass, useMacFullscreen } from "../mac-titlebar";
import { isLightTheme } from "../themes";
import { openQuickChat } from "../quick-chat-launch";
import { AGENTS, type SkillDto } from "../types";
import { planIsEmpty, planSkillInstall, runSkillInstall } from "../skill-install";
import { canOneClickInstall } from "../dep-check";
import { DepInstallLog, useDepInstall } from "../dep-install";
import { diagnose, installToolHelp, useAgentInstall } from "../agent-install";
import { installNotes, isWingetMethod } from "../agent-install-notes";
import { connectOfficialAccount, startOfficialLogin } from "../connect-official";
import {
  connectStage,
  officialShortcutLabel,
  ONBOARDING_CHAT_STARTERS,
  onboardingProgress,
  ONBOARDING_STEPS,
  SAMPLE_PROMPT,
  stepById,
  stepTransitionDir,
  type OnboardingChatStarter,
  type OnboardingFacts,
  type OnboardingStepId,
} from "../onboarding";
import AgentIcon from "./AgentIcon";
import { MesaMark } from "./MesaMark";
import WindowControls from "./WindowControls";
import { GatewayQuickForm } from "./GatewayQuickForm";
import {
  Collapse,
  FoldMark,
  InlineNotice,
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
  surfaceFieldClass,
} from "./PageFrame";

/**
 * 全屏上手向导（2026-10-29 起）：占满主窗口、一次只讲一件事，
 * 三屏（接上 AI / 聊第一句 / 建第一个项目），顶部进度、底部「稍后再说 / 上一步 / 下一步」。
 * 屏上显示什么全由数据现算（onboarding.ts），做完一件事当场看见结果；不另存「做到第几步」。
 * 覆盖层盖住 App 标题栏，自带拖动条与 macOS 红绿灯让位（口径同 ReaderOverlay）。
 */

const RECOMMENDED = ["claude-code", "codex"] as const;
const EMPTY_IDS: readonly string[] = [];
const BLURB: Record<string, string> = {
  "claude-code": "Anthropic 出品，文献精读、写作与编码都顺手",
  codex: "OpenAI 出品，擅长代码分析与长程科研脚本",
};
const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])';

export function OnboardingWizard({ facts }: { facts: OnboardingFacts }) {
  const open = useAppStore((s) => s.onboardingWizardOpen);
  const setOpen = useAppStore((s) => s.setOnboardingWizardOpen);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);
  // 引导已完成或点过「不再显示」：只是从帮助菜单回来看，底栏不再给「稍后再说 / 不再显示」
  const retired = useAppStore((s) => s.onboarding.status !== "active");
  const light = isLightTheme(useAppStore((s) => s.settings?.theme));
  const macFullscreen = useMacFullscreen(IS_MAC);
  const { render, exiting, closeNow } = useExitRender(open, 140);
  const progress = onboardingProgress(facts);
  const [stepState, setStepState] = useState<{
    view: OnboardingStepId;
    dir: "none" | "forward" | "backward";
  }>({ view: "connect", dir: "none" });
  const { view, dir } = stepState;
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const viewRef = useRef(view);
  viewRef.current = view;

  const pickView = useCallback((next: OnboardingStepId) => {
    setStepState((prev) =>
      prev.view === next
        ? prev
        : { view: next, dir: stepTransitionDir(prev.view, next) },
    );
  }, []);

  // 每次打开落在第一个没做完的一屏，初次展示不带左右横移
  useEffect(() => {
    if (open) setStepState({ view: progress.current ?? "project", dir: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 纯关闭（Esc / 稍后再说 / 完成）：走 140ms 退场淡出 */
  const close = useCallback(() => {
    if (!busyRef.current) setOpen(false);
  }, [setOpen]);

  /** 跳转类动作（开对话 / 去登录 / 去网关库 / 去设置 / 建项目）：立即卸载，不留半透明退场残影压在目标页上 */
  const leaveAndRun = useCallback(
    (action: () => void) => {
      if (busyRef.current) return;
      closeNow();
      setOpen(false);
      action();
    },
    [closeNow, setOpen],
  );

  const index = ONBOARDING_STEPS.findIndex((s) => s.id === view);
  const last = index === ONBOARDING_STEPS.length - 1;
  const viewDone = progress.steps[index]?.done ?? false;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        // 下拉菜单（MenuSelect）或弹出菜单正展开时，让它自己先接 Escape 收起，不误关整个向导
        if (document.querySelector('[role="listbox"]:not(.ccode-exiting), [role="menu"]:not(.ccode-exiting)')) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) setOpen(false);
        return;
      }
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.isComposing &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        if (busyRef.current) return;
        const curIdx = ONBOARDING_STEPS.findIndex((s) => s.id === viewRef.current);
        const nextIdx = event.key === "ArrowLeft" ? curIdx - 1 : curIdx + 1;
        const target = ONBOARDING_STEPS[nextIdx];
        if (target) {
          event.preventDefault();
          pickView(target.id);
        }
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusable = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.closest("[inert]"),
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      const outside = !rootRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside || document.activeElement === headingRef.current)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && (document.activeElement === lastEl || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, setOpen, pickView]);

  useEffect(() => {
    if (!open || !render) return;
    const frame = requestAnimationFrame(() => {
      if (mainRef.current) mainRef.current.scrollTop = 0;
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, render, view]);

  if (!render) return null;
  const step = stepById(view);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-summary"
      data-surface="canvas"
      className={`ccode-wizard-shell ccode-covers-titlebar fixed inset-0 z-40 flex flex-col bg-canvas${exiting ? " ccode-exiting" : ""}`}
    >
      <div className="ccode-wizard-enter flex min-h-0 flex-1 flex-col">
        <div
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
            if (IS_WINDOWS && e.detail === 2) {
              void getCurrentWindow().toggleMaximize().catch(() => {});
              return;
            }
            void getCurrentWindow().startDragging().catch(() => {});
          }}
          className={`flex h-10 shrink-0 items-center justify-between ${IS_WINDOWS ? "pr-0" : "pr-3"} ${macOverlayPadClass(
            IS_MAC,
            macFullscreen,
            "pl-3",
          )}`}
        >
          <span className="flex items-baseline gap-2 text-sm text-l2">
            <MesaMark light={light} className="h-[0.85em] w-auto shrink-0" />
            <span>Mesa</span>
          </span>
          {IS_WINDOWS && <WindowControls className="ml-1" />}
        </div>

        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[42rem] px-6 pb-8 pt-[clamp(1rem,6vh,3.5rem)]">
            <div className="mb-3 flex items-center justify-between text-xs text-l3">
              <span>欢迎使用 Mesa · 三步上手</span>
              <span role="status" className="rounded-full bg-inset px-2.5 py-0.5 text-micro tabular-nums text-l2">
                已完成 {progress.doneCount} / {progress.total}
              </span>
            </div>
            <Progress current={view} steps={progress.steps} onPick={pickView} disabled={busy} />

            <div key={view} data-dir={dir} className="ccode-wizard-step mt-8">
              <h1
                id="onboarding-title"
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight text-l1 outline-none"
              >
                {step.headline}
              </h1>
              <p id="onboarding-summary" className="mt-2 text-sm leading-6 text-l3">
                {step.summary}
              </p>
              <div data-wizard-content aria-busy={busy} className="mt-6">
                {view === "connect" && (
                  <ConnectScreen facts={facts} onBusyChange={setBusy} onLeave={leaveAndRun} />
                )}
                {view === "chat" && (
                  <ChatScreen
                    done={viewDone}
                    connected={facts.profileCount > 0}
                    onConnect={() => pickView("connect")}
                    onLeave={leaveAndRun}
                  />
                )}
                {view === "project" && <ProjectScreen done={viewDone} onLeave={leaveAndRun} />}
              </div>
            </div>
          </div>
        </main>

        {/* 发丝线贯通整窗：内容滚到底栏下面时有个边，不像被截断 */}
        <footer className="shrink-0 border-t border-hairline text-xs">
          <div className="mx-auto flex w-full max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3">
            {!retired && (
              <div className="-ml-3 flex items-center gap-1">
                <button type="button" className={quietActionClass} disabled={busy} onClick={close}>
                  稍后再说
                </button>
                <button
                  type="button"
                  className={quietActionClass}
                  disabled={busy}
                  title="永久收起：不再自动弹出，侧栏那一行和右下角提示一并去掉；想再看，到顶栏「帮助 → 上手引导」"
                  onClick={() => {
                    updateOnboarding({ status: "dismissed" });
                    close();
                  }}
                >
                  不再显示
                </button>
              </div>
            )}
            <p className="min-w-0 flex-1 truncate text-l4" role="status">
              {busy
                ? "正在处理，请稍候…"
                : retired
                  ? "引导已收起，只在「帮助 → 上手引导」里"
                  : "随时可从「帮助 → 上手引导」回来"}
            </p>
            <div className="ml-auto flex items-center gap-2">
              {index > 0 && (
                <button
                  type="button"
                  className={`${secondaryActionClass} gap-1.5`}
                  disabled={busy}
                  onClick={() => pickView(ONBOARDING_STEPS[index - 1]!.id)}
                >
                  <ArrowLeft size={13} aria-hidden="true" />
                  上一步
                </button>
              )}
              {last ? (
                <button type="button" className={primaryActionClass} disabled={busy} onClick={close}>
                  {progress.doneCount === progress.total ? "完成" : retired ? "关闭" : "先去体验"}
                </button>
              ) : (
                <button
                  type="button"
                  className={`${viewDone ? primaryActionClass : quietActionClass} gap-1.5`}
                  disabled={busy}
                  onClick={() => pickView(ONBOARDING_STEPS[index + 1]!.id)}
                >
                  {viewDone ? "下一步" : "跳过这步"}
                  <ArrowRight size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Progress({
  current,
  steps,
  onPick,
  disabled,
}: {
  current: OnboardingStepId;
  steps: { step: { id: OnboardingStepId; title: string }; done: boolean }[];
  onPick: (id: OnboardingStepId) => void;
  disabled: boolean;
}) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 一行横向步进：圆点 + 名字，步与步之间一条细轨（前一步做完连线从左向右生长着色），三步全在一眼之内
  return (
    <ol className="-ml-1 -mr-3 flex items-center" aria-label="上手步骤">
      {steps.map(({ step, done }, i) => {
        const isCurrent = step.id === current;
        const prevDone = i > 0 && steps[i - 1]!.done;
        return (
          <li key={step.id} className={`flex min-w-0 items-center ${i > 0 ? "flex-1" : "shrink-0"}`}>
            {i > 0 && (
              <span
                aria-hidden="true"
                className="relative mx-2 h-[1.5px] min-w-4 flex-1 overflow-hidden rounded-full bg-hairline"
              >
                <span
                  className={`block h-full w-full origin-left rounded-full bg-ok-text/70 transition-transform duration-300 ease-[var(--ccode-motion-ease)] ${
                    prevDone ? "scale-x-100" : "scale-x-0"
                  }`}
                />
              </span>
            )}
            <button
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              type="button"
              onClick={() => onPick(step.id)}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === "ArrowLeft" && i > 0) {
                  e.preventDefault();
                  const prev = steps[i - 1]!;
                  onPick(prev.step.id);
                  buttonRefs.current[i - 1]?.focus();
                } else if (e.key === "ArrowRight" && i < steps.length - 1) {
                  e.preventDefault();
                  const next = steps[i + 1]!;
                  onPick(next.step.id);
                  buttonRefs.current[i + 1]?.focus();
                }
              }}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${step.title}，${done ? "已完成" : isCurrent ? "当前步骤" : "未完成"}`}
              disabled={disabled}
              className={`group flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isCurrent ? "bg-hover/70" : "hover:bg-hover"
              }`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums transition-all duration-200 ${
                  isCurrent
                    ? "bg-cta font-medium text-cta-text ring-3 ring-cta/15"
                    : done
                      ? "bg-ok text-ok-text"
                      : "bg-field text-l3"
                }`}
              >
                {done ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : i + 1}
              </span>
              <span
                className={`whitespace-nowrap text-xs transition-colors ${
                  isCurrent
                    ? "font-medium text-l1"
                    : done
                      ? "text-l2 group-hover:text-l1"
                      : "text-l3 group-hover:text-l2"
                }`}
              >
                {step.title}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ccode-well rounded-xl p-5 text-xs ${className}`}>{children}</div>;
}

function SuccessCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <Card className="flex items-start gap-3.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok text-ok-text">
        <Check size={13} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <div role="status" className="min-w-0 flex-1">
        <p className="text-sm font-medium text-l1">{title}</p>
        {detail && <p className="mt-0.5 text-xs leading-5 text-l3">{detail}</p>}
        {children}
      </div>
    </Card>
  );
}

/* ---------- 第一屏：接上 AI ---------- */

function ConnectScreen({
  facts,
  onBusyChange,
  onLeave,
}: {
  facts: OnboardingFacts;
  onBusyChange: (busy: boolean) => void;
  onLeave: (action: () => void) => void;
}) {
  const stage = connectStage(facts);
  const profiles = useAppStore((s) => s.profiles);
  // 做完了回来看：结果在上，原来的接入流程收在「再接一个」里，点开可再走一遍，也能随时收起
  const [again, setAgain] = useState(false);
  if (stage === "done") {
    const skillAgents = [...new Set(profiles.map((p) => p.agent))].filter((a) =>
      facts.installedAgents.includes(a),
    );
    return (
      <div className="space-y-4">
        <SuccessCard
          title={
            profiles.length > 1
              ? `已添加 ${profiles.length} 条连接`
              : `${labelOf(profiles[0]?.agent ?? "")} 连接已添加`
          }
          detail="连接配置已就绪；下一步发一句话，确认 AI 能正常回复。"
        >
          {profiles.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {profiles.slice(0, 6).map((p, idx) => (
                <span
                  key={p.id ?? `${p.agent}-${idx}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-micro text-l2"
                >
                  <AgentIcon agent={p.agent} label={labelOf(p.agent)} size={13} />
                  <span>
                    {labelOf(p.agent)}
                    {p.name ? ` · ${p.name}` : ""}
                  </span>
                </span>
              ))}
              {profiles.length > 6 && (
                <span className="inline-flex items-center rounded-full bg-raised px-2 py-1 text-micro text-l3">
                  +{profiles.length - 6}
                </span>
              )}
            </div>
          )}
        </SuccessCard>
        {skillAgents.map((agent) => (
          <BuiltinSkillsCard key={agent} agent={agent} onBusyChange={onBusyChange} />
        ))}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              aria-expanded={again}
              className={`${secondaryActionClass} gap-1.5`}
              onClick={() => setAgain((v) => !v)}
            >
              {again ? (
                <>
                  <ChevronUp size={13} aria-hidden="true" />
                  收起
                </>
              ) : (
                <>
                  <Plus size={13} aria-hidden="true" />
                  再接一个
                </>
              )}
            </button>
            <span className="text-l3">换一家 Agent、另一个服务商，或改用官方账号</span>
          </div>
          <Collapse open={again} className="pt-1">
            {facts.installedAgents.length ? (
              <ChooseStage
                facts={facts}
                onBusyChange={onBusyChange}
                onLeave={onLeave}
                onDone={() => setAgain(false)}
              />
            ) : (
              <InstallStage onBusyChange={onBusyChange} onLeave={onLeave} />
            )}
          </Collapse>
        </div>
      </div>
    );
  }
  return stage === "install" ? (
    <InstallStage onBusyChange={onBusyChange} onLeave={onLeave} />
  ) : (
    <ChooseStage facts={facts} onBusyChange={onBusyChange} onLeave={onLeave} />
  );
}

/** 内置技能只进了 Mesa 的技能库，没写进各 CLI 的技能目录：接好连接后在这里点一下装给这家 Agent，
 *  否则流程步骤开工被「开工前要处理」拦下、对话里点名 /lit-search 也找不到。人点了才写。
 *  本卡用次按钮，把同屏唯一主按钮留给页脚「下一步」（design-system「主钮只给当前该点的那一个」）。 */
function BuiltinSkillsCard({ agent, onBusyChange }: { agent: string; onBusyChange: (busy: boolean) => void }) {
  const [skills, setSkills] = useState<SkillDto[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((rows) => {
        if (!stale) setSkills(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!stale) setSkills([]);
      });
    return () => {
      stale = true;
    };
  }, []);
  if (!skills) return null;
  const plan = planSkillInstall(skills, null, agent);
  const total = skills.filter((s) => s.source === "builtin" && agent in s.apps).length;
  const label = labelOf(agent);
  if (total === 0) return null;
  if (planIsEmpty(plan)) {
    return installed ? (
      <SuccessCard
        title={`内置技能已装给 ${label}`}
        detail="流程步骤会按这些技能干活；对话里也能点名用。"
      />
    ) : null;
  }
  const pending = plan.enable.length + plan.resync.length;
  const install = async () => {
    setRunning(true);
    setError(null);
    onBusyChange(true);
    try {
      await runSkillInstall(plan, agent);
      setInstalled(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      const rows = await invoke<SkillDto[]>("list_skills").catch(() => null);
      if (Array.isArray(rows)) setSkills(rows);
      setRunning(false);
      onBusyChange(false);
    }
  };
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={agent} label={label} size={18} />
          <p className="text-sm font-medium text-l1">把 Mesa 内置技能装给 {label}</p>
        </div>
        <button
          type="button"
          className={`${secondaryActionClass} shrink-0`}
          disabled={running}
          onClick={() => void install()}
        >
          {running ? "正在安装…" : `装给 ${label}`}
        </button>
      </div>
      <p className="leading-5 text-l3">
        Mesa 自带 {total} 个科研技能（文献检索、精读笔记、作图、写作等），现在只在 Mesa 的技能库里，{label} 还读不到
        {pending < total ? `（还差 ${pending} 个）` : ""}。装上后研究流程的步骤才能直接开工，放进 {label} 自己的技能目录、不动你原有的技能；以后在「技能」页可以逐个取消。
      </p>
      {error && (
        <InlineNotice tone="err">
          没装完：{error}。可以再点一次，已装上的不会重复装。
        </InlineNotice>
      )}
    </Card>
  );
}

function InstallStage({
  onBusyChange,
  onLeave,
  excludeIds = EMPTY_IDS,
  compact = false,
}: {
  onBusyChange: (busy: boolean) => void;
  onLeave: (action: () => void) => void;
  excludeIds?: readonly string[];
  compact?: boolean;
}) {
  const install = useAgentInstall();
  const depCheck = useAppStore((s) => s.depCheck);
  const outboundProxy = useAppStore((s) => s.settings?.outboundProxy?.trim());
  const refreshDepCheck = useAppStore((s) => s.refreshDepCheck);
  const [showOthers, setShowOthers] = useState(false);
  const [nodeFor, setNodeFor] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const nodeForRef = useRef<string | null>(null);
  nodeForRef.current = nodeFor;

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const depInstall = useDepInstall((_tool, res) => {
    if (!res.ok) return;
    void refreshDepCheck();
    const pending = nodeForRef.current;
    setNodeFor(null);
    // Node 装好后接着走刚才那家的安装；先刷新命令预览再装
    if (pending) void install.loadPreviews([pending]).then(() => install.install(pending));
  });
  const installing =
    Object.values(install.entries).some((entry) => entry.running) || depInstall.entries.node.running;
  useEffect(() => {
    onBusyChange(installing);
    return () => onBusyChange(false);
  }, [installing, onBusyChange]);

  const openProxySettings = () => {
    onLeave(() => {
      const s = useAppStore.getState();
      s.setSettingsSectionReq("network");
      s.setPage("settings");
    });
  };

  const redetect = async () => {
    if (redetecting || installing) return;
    setRedetecting(true);
    try {
      await useAppStore.getState().loadAll();
    } catch {
      /* 忽略 */
    } finally {
      setRedetecting(false);
    }
  };

  const copyMethod = (id: string, cmd: string) => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopiedId(id);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const recommendedList = useMemo(
    () => RECOMMENDED.filter((id) => !excluded.has(id)),
    [excluded],
  );
  const others = useMemo(
    () =>
      AGENTS.filter(
        (a) => !(RECOMMENDED as readonly string[]).includes(a.id) && !excluded.has(a.id),
      ),
    [excluded],
  );
  const ids = useMemo(
    () => AGENTS.map((a) => a.id as string).filter((id) => !excluded.has(id)),
    [excluded],
  );

  useEffect(() => {
    if (ids.length) void install.loadPreviews(ids);
    if (!useAppStore.getState().depCheck) void refreshDepCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);

  // 推荐两家都已经装过时（比如在「安装其他 Agent」面板里），直接展开其余列表
  const effectiveShowOthers = showOthers || recommendedList.length === 0;

  function renderCard(id: string, recommended: boolean) {
    const entry = install.entries[id];
    const method = install.previews[id];
    const noTool = method === null;
    const failed = Boolean(entry?.result && !entry.result.ok && !entry.running);
    const expanded = Boolean(entry?.running || failed || (noTool && nodeFor === id));
    const hint = failed && entry?.result ? diagnose(entry.result.output, entry.result.method, IS_WINDOWS) : null;
    const notes =
      method && !entry?.running && !entry?.result
        ? installNotes(id, method, {
            isWindows: IS_WINDOWS,
            proxyConfigured: !!outboundProxy,
            gitMissing: depCheck?.git.status === "missing",
          })
        : [];
    return (
      <Card
        key={id}
        className={`flex flex-col justify-between gap-2.5 ${expanded ? "sm:col-span-2" : ""}`}
      >
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <AgentIcon
                agent={id}
                label={labelOf(id)}
                size={recommended ? 20 : 18}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-medium text-l1">{labelOf(id)}</p>
                  {recommended && (
                    <span className="rounded-full bg-raised px-2 py-0.5 text-micro text-l3">
                      推荐
                    </span>
                  )}
                </div>
                {recommended && BLURB[id] && (
                  <p className="mt-0.5 text-xs leading-5 text-l3">{BLURB[id]}</p>
                )}
              </div>
            </div>
            <button
              type="button"
              className={`${secondaryActionClass} shrink-0`}
              disabled={installing || method === undefined}
              onClick={() => {
                if (noTool) {
                  setNodeFor(id);
                  return;
                }
                void install.install(id);
              }}
            >
              {entry?.running
                ? "安装中…"
                : method === undefined
                  ? "检查中…"
                  : failed
                    ? "重试"
                    : "安装"}
            </button>
          </div>

          {method && !entry?.running && !entry?.result && (
            <div className="group flex items-center justify-between gap-2 rounded-lg bg-field px-2.5 py-1.5">
              <p className="min-w-0 truncate font-mono text-micro leading-5 text-l3" title={method}>
                {method}
              </p>
              <button
                type="button"
                aria-label={`复制 ${labelOf(id)} 安装命令`}
                title="复制命令（方便在外部终端安装）"
                onClick={() => copyMethod(id, method)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-l4 transition-colors hover:bg-hover hover:text-l1"
              >
                {copiedId === id ? (
                  <Check size={11} className="text-ok-text" aria-hidden="true" />
                ) : (
                  <Copy size={11} aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          {notes.map((note) => (
            <p key={note} className="text-xs leading-5 text-l3">
              {note}
            </p>
          ))}

          {noTool && nodeFor !== id && (
            <p className="text-xs leading-5 text-l3">这台电脑缺少安装工具，点「安装」看怎么补。</p>
          )}
          {noTool && nodeFor === id && (
            <div className="space-y-2 pt-1">
              <p className="text-xs leading-5 text-l3">{installToolHelp(id, IS_WINDOWS)}</p>
              {depCheck && canOneClickInstall("node", depCheck.channel) && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={`${secondaryActionClass} text-xs`}
                    disabled={depInstall.entries.node.running}
                    onClick={() => void depInstall.install("node")}
                  >
                    {depInstall.entries.node.running ? "安装中…" : "一键安装 Node.js"}
                  </button>
                  {!depInstall.entries.node.running && (
                    <span className="text-xs text-l3">装好后自动接着安装 {labelOf(id)}</span>
                  )}
                </div>
              )}
              <DepInstallLog entry={depInstall.entries.node} />
            </div>
          )}
          {entry?.running && (
            <pre
              ref={(el) => {
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md bg-inset p-2.5 font-mono text-micro text-l3"
            >
              {entry.output.trim() || "安装中，等待输出…"}
            </pre>
          )}
          {failed && entry?.result && (
            <div className="space-y-2 pt-1">
              <InlineNotice tone="err">安装失败{hint ? `：${hint}` : ""}</InlineNotice>
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-inset p-2.5 font-mono text-micro text-l3">
                {entry.result.output.trim().slice(-1200)}
              </pre>
              {/* winget 不走 Mesa 的出网代理，「去设置出网代理」对它没用；它的下一步已在 hint 里 */}
              {!isWingetMethod(entry.result.method) && (
                <p className="text-xs leading-5 text-l3">
                  下载慢或连不上，多半是网络问题：
                  <button
                    type="button"
                    className="ml-1 text-cta hover:underline"
                    disabled={installing}
                    onClick={openProxySettings}
                  >
                    去设置出网代理
                  </button>
                  ，填好再点「重试」。
                </p>
              )}
            </div>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {!compact && <p className="text-xs leading-5 text-l3">先选一个安装，之后可以随时添加其他 Agent。</p>}
      {recommendedList.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {recommendedList.map((id) => renderCard(id, true))}
        </div>
      )}
      {others.length > 0 && recommendedList.length > 0 && (
        <button
          type="button"
          className={`${quietActionClass} -ml-3 gap-1`}
          aria-expanded={effectiveShowOthers}
          aria-controls="onboarding-other-agents"
          onClick={() => setShowOthers((v) => !v)}
        >
          <FoldMark open={effectiveShowOthers} />
          {effectiveShowOthers ? "收起其他 Agent" : `其他 Agent（${others.length}）…`}
        </button>
      )}
      {others.length > 0 && (
        <Collapse open={effectiveShowOthers}>
          <div id="onboarding-other-agents" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {others.map((a) => renderCard(a.id, false))}
          </div>
        </Collapse>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1 text-xs text-l3">
        <span>
          下载慢或连不上？
          <button
            type="button"
            className="ml-1 text-cta hover:underline"
            disabled={installing}
            onClick={openProxySettings}
          >
            去设置出网代理
          </button>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span>已在终端装好？切回窗口自动识别，或</span>
          <button
            type="button"
            disabled={installing || redetecting}
            onClick={() => void redetect()}
            className="inline-flex items-center gap-1 text-cta hover:underline disabled:opacity-50"
          >
            <RefreshCw
              size={11}
              className={redetecting ? "animate-spin" : ""}
              aria-hidden="true"
            />
            {redetecting ? "检测中…" : "重新检测"}
          </button>
        </span>
      </div>
    </div>
  );
}

function ChooseStage({
  facts,
  onBusyChange,
  onLeave,
  onDone = () => {},
}: {
  facts: OnboardingFacts;
  onBusyChange: (busy: boolean) => void;
  onLeave: (action: () => void) => void;
  /** 接好一条（「再接一个」时收起流程用） */
  onDone?: () => void;
}) {
  const official = useAppStore((s) => s.onboardingOfficial);
  const installed = facts.installedAgents;
  const defaultAgent = facts.officialReady?.[0] ?? installed[0]!;
  const [picked, setPicked] = useState(defaultAgent);
  const agent = installed.includes(picked) ? picked : defaultAgent;
  const probe = official[agent];
  const [method, setMethod] = useState<"official" | "key" | null>(null);
  const active = method ?? (probe === "ready" || probe === "login" ? "official" : "key");
  const [connectBusy, setConnectBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [showInstallMore, setShowInstallMore] = useState(false);
  const busy = connectBusy || installBusy;

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  // 在「安装其他 Agent」里新装好一家 CLI 后，自动切到这家并收起安装列表
  const prevInstalledRef = useRef<readonly string[]>(installed);
  useEffect(() => {
    const prev = prevInstalledRef.current;
    prevInstalledRef.current = installed;
    const added = installed.find((id) => !prev.includes(id));
    if (added) {
      setPicked(added);
      setMethod(null);
      setShowInstallMore(false);
    }
  }, [installed]);

  function openGatewayLibrary() {
    onLeave(() => {
      const s = useAppStore.getState();
      s.setPage("profiles");
      s.setGatewayLibraryReq({ token: Date.now(), create: true });
    });
  }

  const canInstallMore = installed.length < AGENTS.length;

  return (
    <div className="space-y-4">
      {/* 只装了一家就直说装好了；装了几家给一排选择（按钮上的字号写在容器上：全站 button 的 font: inherit 会吞掉按钮自己的 text-*） */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {installed.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-l3">已装好，选一个：</span>
            {installed.map((id) => (
              <button
                key={id}
                type="button"
                disabled={busy}
                aria-pressed={id === agent}
                onClick={() => {
                  setPicked(id);
                  setMethod(null);
                }}
                className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  id === agent
                    ? "border-cta bg-cta/10 font-medium text-l1"
                    : "border-hairline text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                <AgentIcon agent={id} label={labelOf(id)} size={14} />
                <span>{labelOf(id)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-l2">
            <AgentIcon agent={agent} label={labelOf(agent)} size={16} />
            <span>{labelOf(agent)} 已装好</span>
            <Check size={14} className="text-ok-text" aria-hidden="true" />
          </p>
        )}
        {canInstallMore && (
          <button
            type="button"
            disabled={busy}
            aria-expanded={showInstallMore}
            onClick={() => setShowInstallMore((v) => !v)}
            className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {showInstallMore ? (
              <>
                <ChevronUp size={13} aria-hidden="true" />
                收起安装列表
              </>
            ) : (
              <>
                <Plus size={13} aria-hidden="true" />
                安装其他 Agent
              </>
            )}
          </button>
        )}
      </div>

      {canInstallMore && (
        <Collapse open={showInstallMore}>
          <div className="rounded-xl border border-hairline p-4">
            <p className="mb-3 text-xs text-l3">再装一家 Agent CLI（装好后自动切过去配置连接）：</p>
            <InstallStage
              excludeIds={installed}
              compact
              onBusyChange={setInstallBusy}
              onLeave={onLeave}
            />
          </div>
        </Collapse>
      )}

      {probe === undefined && (
        <Card>
          <p role="status" className="text-sm text-l3">
            正在检查官方账号登录状态…
          </p>
        </Card>
      )}

      {(probe === "ready" || probe === "login") && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" role="group" aria-label="接入方式">
          {(
            [
              [
                "official",
                "官方账号",
                `登录 ${labelOf(agent)} 自家账号`,
                probe === "ready" ? "已登录" : "需登录",
              ],
              ["key", "服务商 API Key", "服务商或中转站的地址和密钥，按量计费", null],
            ] as const
          ).map(([id, label, hint, badge]) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              aria-pressed={active === id}
              aria-label={label}
              onClick={() => setMethod(id)}
              className={`flex items-start gap-2.5 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active === id ? "border-cta bg-cta/10" : "border-hairline hover:bg-hover"
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  active === id ? "border-cta bg-cta" : "border-l4"
                }`}
              >
                {active === id && <span className="h-1.5 w-1.5 rounded-full bg-cta-text" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className={`text-sm ${active === id ? "font-medium text-l1" : "text-l2"}`}>
                    {label}
                  </span>
                  {badge && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-micro ${
                        probe === "ready" ? "bg-ok text-ok-text" : "bg-inset text-l3"
                      }`}
                    >
                      {badge}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-l3">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {active === "official" && probe === "ready" && (
        <Card className="ccode-fade space-y-3">
          <div className="flex items-center gap-2">
            <AgentIcon agent={agent} label={labelOf(agent)} size={18} />
            <p className="text-sm font-medium text-l1">官方账号已登录</p>
          </div>
          <p className="text-xs leading-5 text-l3">直接使用本机已登录的账号接入，无须填写网关与密钥。</p>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy}
            onClick={() => {
              setConnectBusy(true);
              void connectOfficialAccount(agent)
                .then((ok) => {
                  if (ok) onDone();
                })
                .finally(() => setConnectBusy(false));
            }}
          >
            {connectBusy ? "接入中…" : officialShortcutLabel(labelOf(agent))}
          </button>
        </Card>
      )}
      {active === "official" && probe === "login" && (
        <Card className="ccode-fade space-y-3">
          <div className="flex items-center gap-2">
            <AgentIcon agent={agent} label={labelOf(agent)} size={18} />
            <p className="text-sm font-medium text-l1">先登录 {labelOf(agent)} 官方账号</p>
          </div>
          <p className="text-xs leading-5 text-l3">在终端按提示完成登录，切回向导就能一键接入。</p>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy}
            onClick={() =>
              onLeave(() => {
                void startOfficialLogin(agent);
              })
            }
          >
            去登录 {labelOf(agent)}
          </button>
        </Card>
      )}
      {probe === "none" && (
        <p className="text-xs leading-5 text-l3">
          {labelOf(agent)} 没有官方账号登录方式，用服务商给你的 API Key 接入。
        </p>
      )}
      {active === "key" && probe !== undefined && (
        <Card className="ccode-fade">
          <GatewayQuickForm
            key={agent}
            agent={agent}
            onConnected={onDone}
            onMore={openGatewayLibrary}
            onBusyChange={setConnectBusy}
          />
        </Card>
      )}
    </div>
  );
}

/* ---------- 第二屏：聊第一句 ---------- */

function ChatScreen({
  done,
  connected,
  onConnect,
  onLeave,
}: {
  done: boolean;
  connected: boolean;
  onConnect: () => void;
  onLeave: (action: () => void) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const [pickedProfileId, setPickedProfileId] = useState<string | null>(null);
  const chosenProfile =
    (pickedProfileId ? profiles.find((p) => p.id === pickedProfileId) : undefined) ?? profiles[0];

  const [starterId, setStarterId] = useState<OnboardingChatStarter["id"] | null>("overview");
  const [promptText, setPromptText] = useState(SAMPLE_PROMPT);
  const [tipsOpen, setTipsOpen] = useState(false);

  if (!connected) {
    return (
      <Card className="space-y-3">
        <p className="text-sm font-medium text-l1">先添加一条 AI 连接</p>
        <p className="text-xs leading-5 text-l3">接好账号或密钥后，就能开始第一段对话。</p>
        <button type="button" className={primaryActionClass} onClick={onConnect}>
          去接上 AI
        </button>
      </Card>
    );
  }

  const targetProfile = chosenProfile?.id
    ? { id: chosenProfile.id, agent: chosenProfile.agent, models: chosenProfile.models }
    : undefined;

  const sendPrompt = () => {
    const text = promptText.trim() || SAMPLE_PROMPT;
    onLeave(() => {
      void openQuickChat(text, targetProfile);
    });
  };

  return (
    <div className="space-y-4">
      {done && (
        <SuccessCard
          title="已经聊过了"
          detail="第一段对话在侧栏「随手聊」里。想换条连接或换个问题再试一次，照下面发出去。"
        />
      )}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-l1">
            <MessageSquare size={16} className="text-cta" aria-hidden="true" />
            试着问 AI
          </div>
          {profiles.length === 1 && chosenProfile && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-micro text-l2">
              <AgentIcon agent={chosenProfile.agent} label={labelOf(chosenProfile.agent)} size={13} />
              <span>
                将使用 {labelOf(chosenProfile.agent)}
                {chosenProfile.name ? ` · ${chosenProfile.name}` : ""}
              </span>
            </span>
          )}
        </div>

        {profiles.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="选择试聊连接">
            <span className="mr-1 text-l3">用哪条连接试：</span>
            {profiles.map((p, idx) => {
              const selected = p === chosenProfile;
              return (
                <button
                  key={p.id ?? `${p.agent}-${idx}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPickedProfileId(p.id ?? null)}
                  className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors ${
                    selected
                      ? "border-cta bg-cta/10 font-medium text-l1"
                      : "border-hairline text-l3 hover:bg-hover hover:text-l1"
                  }`}
                >
                  <AgentIcon agent={p.agent} label={labelOf(p.agent)} size={13} />
                  <span>
                    {labelOf(p.agent)}
                    {p.name ? ` · ${p.name}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="试问场景">
            <Sparkles size={12} className="mr-0.5 text-l4" aria-hidden="true" />
            {ONBOARDING_CHAT_STARTERS.map((s) => {
              const active = starterId === s.id && promptText === s.prompt;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setStarterId(s.id);
                    setPromptText(s.prompt);
                  }}
                  className={`rounded-full px-2.5 py-1 transition-colors ${
                    active
                      ? "bg-seg-sel font-medium text-l1"
                      : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <textarea
            rows={3}
            aria-label="试问内容"
            value={promptText}
            onChange={(e) => {
              setPromptText(e.target.value);
              const matched = ONBOARDING_CHAT_STARTERS.find((s) => s.prompt === e.target.value);
              setStarterId(matched?.id ?? null);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendPrompt();
              }
            }}
            placeholder={SAMPLE_PROMPT}
            className={`${surfaceFieldClass} resize-none px-3 py-2.5 leading-6 text-l1`}
          />
        </div>

        <p className="text-xs leading-5 text-l3">
          可以直接修改上面的句子再点发送（{IS_MAC ? "⌘Enter" : "Ctrl+Enter"}），AI 有回复就说明连接通了。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryActionClass} onClick={sendPrompt}>
            {done ? "再发一次试试" : "发这一句试试"}
          </button>
          <button
            type="button"
            className={quietActionClass}
            onClick={() =>
              onLeave(() => {
                void openQuickChat(undefined, targetProfile);
              })
            }
          >
            自己写一句
          </button>
        </div>
      </Card>

      <div className="px-1 text-xs text-l3">
        <button
          type="button"
          aria-expanded={tipsOpen}
          aria-controls="onboarding-chat-tips"
          onClick={() => setTipsOpen((v) => !v)}
          className="flex items-center gap-1 rounded-md py-1.5 text-left transition-colors hover:text-l1"
        >
          <FoldMark open={tipsOpen} />
          <span>聊天与终端、自动标题</span>
        </button>
        <Collapse open={tipsOpen} className="pl-5 pt-1.5">
          <div id="onboarding-chat-tips" className="space-y-2.5 leading-5">
            <p className="flex items-start gap-2">
              <Terminal size={14} className="mt-0.5 shrink-0 text-l4" aria-hidden="true" />
              <span>运行页右上角的 {">_"} 可切到同一段对话的终端，查看命令与完整输出。</span>
            </p>
            <p>
              标题由 AI 自动起，会用少量 token；可右键重命名，或在「设置 → AI 与 Agent」关闭「会话自动命名」。
            </p>
          </div>
        </Collapse>
      </div>
    </div>
  );
}

/* ---------- 第三屏：建第一个项目 ---------- */

function ProjectScreen({
  done,
  onLeave,
}: {
  done: boolean;
  onLeave: (action: () => void) => void;
}) {
  const go = (run: (s: ReturnType<typeof useAppStore.getState>) => void) => {
    onLeave(() => {
      const s = useAppStore.getState();
      s.setPage("workspaces");
      run(s);
    });
  };
  // 先问手上有什么活，不首推综述示例（2026-11-08 用户拍板「科研项目不先套流程」）：建好的项目先是目标列表，
  // 示例课题降为「想先看完整流程长什么样」。卡片标题是回答，后面小字是入口原名（说明书照它写）
  const actions = [
    {
      answer: "资料已经在电脑上",
      label: "添加已有文件夹",
      hint: "文献、数据或稿子已经在一个文件夹里：加进来，Mesa 自动认出里面的文献和数据，接着写这次想完成什么",
      icon: FolderOpen,
      run: (s: ReturnType<typeof useAppStore.getState>) => s.setAddProjectOpenReq(Date.now()),
    },
    {
      answer: "从头开始一个新课题",
      label: "新建项目",
      hint: "建一个新文件夹，起名、选位置；建好就能写这次想完成什么",
      icon: FolderPlus,
      run: (s: ReturnType<typeof useAppStore.getState>) => s.setNewProjectOpenReq({ token: Date.now() }),
    },
    {
      answer: "还没想好，先看个例子",
      label: "创建示例课题",
      hint: "带好文献和英文综述流程的示例课题，照着点一遍，看 AI 怎么检索、精读、写初稿，你怎么评审；随时可以删",
      icon: FlaskConical,
      run: (s: ReturnType<typeof useAppStore.getState>) => s.setDemoProjectOpenReq(Date.now()),
    },
  ];
  return (
    <div className="space-y-3">
      {done && (
        <SuccessCard
          title="项目建好了"
          detail="在侧栏「项目」下面点它，就能开始做课题；在它下面开的对话也列在它名下。还想再建，照下面选。"
        />
      )}
      {actions.map((action, i) => (
        // aria-label 会盖住按钮里的文字：回答和入口名一起写进名字，说明经 aria-describedby 给读屏
        <button
          key={action.label}
          type="button"
          onClick={() => go(action.run)}
          className="ccode-well group flex w-full items-center gap-4 rounded-xl p-5 text-left transition-colors hover:bg-hover"
          aria-label={`${action.answer}：${action.label}`}
          aria-describedby={`onboarding-project-hint-${i}`}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-inset text-l2 transition-colors group-hover:bg-cta/10 group-hover:text-cta">
            <action.icon size={19} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-l1">
              {action.answer}
              <span className="rounded-full bg-raised px-2 py-0.5 text-micro font-normal text-l3">
                {action.label}
              </span>
            </span>
            <span id={`onboarding-project-hint-${i}`} className="mt-1 block text-xs leading-5 text-l3">
              {action.hint}
            </span>
          </span>
          <ArrowRight
            size={16}
            className="shrink-0 text-l3 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-l1"
            aria-hidden="true"
          />
        </button>
      ))}
      {!done && <p className="text-xs leading-5 text-l3">也可以稍后从侧栏「新项目」创建。</p>}
    </div>
  );
}
