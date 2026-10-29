import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Copy, FolderOpen, FolderPlus, FlaskConical, MessageSquare, Plus, Terminal,
} from "lucide-react";
import { useAppStore } from "../store";
import { useExitRender } from "../exit-animation";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { macOverlayPadClass, useMacFullscreen } from "../mac-titlebar";
import { isLightTheme } from "../themes";
import { openQuickChat } from "../quick-chat-launch";
import { AGENTS } from "../types";
import { canOneClickInstall } from "../dep-check";
import { DepInstallLog, useDepInstall } from "../dep-install";
import { diagnose, installToolHelp, useAgentInstall } from "../agent-install";
import { connectOfficialAccount, startOfficialLogin } from "../connect-official";
import {
  connectStage,
  officialShortcutLabel,
  onboardingProgress,
  ONBOARDING_STEPS,
  stepById,
  type OnboardingFacts,
  type OnboardingStepId,
} from "../onboarding";
import { MesaMark } from "./MesaMark";
import WindowControls from "./WindowControls";
import { GatewayQuickForm } from "./GatewayQuickForm";
import {
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
} from "./PageFrame";

/**
 * 全屏上手向导（2026-10-29，取代欢迎弹窗 + 清单浮层 + 连接页引导条）：占满主窗口、一次只讲一件事，
 * 三屏（接上 AI / 聊第一句 / 建第一个项目），顶部进度、底部「稍后再说 / 上一步 / 下一步」。
 * 屏上显示什么全由数据现算（onboarding.ts），做完一件事当场看见结果；不另存「做到第几步」。
 * 覆盖层盖住 App 标题栏，所以自带拖动条与 macOS 红绿灯让位（口径同 ReaderOverlay）。
 */

const RECOMMENDED = ["claude-code", "codex"] as const;
const BLURB: Record<string, string> = {
  "claude-code": "Anthropic 出品，写作、分析、编码都顺手",
  codex: "OpenAI 出品，擅长代码与长任务",
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
  const { render, exiting } = useExitRender(open);
  const progress = onboardingProgress(facts);
  const [view, setView] = useState<OnboardingStepId>("connect");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // 每次打开落在第一个没做完的一屏
  useEffect(() => {
    if (open) setView(progress.current ?? "project");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    if (!busy) setOpen(false);
  };
  const index = ONBOARDING_STEPS.findIndex((s) => s.id === view);
  const last = index === ONBOARDING_STEPS.length - 1;
  const viewDone = progress.steps[index]?.done ?? false;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusable = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
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
  }, [open, setOpen]);

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
      className={`ccode-covers-titlebar fixed inset-0 z-40 flex flex-col bg-canvas ccode-fade${exiting ? " ccode-exiting" : ""}`}
    >
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
        <div className="mx-auto w-full max-w-[42rem] px-6 pb-8 pt-[clamp(1rem,10vh,6rem)]">
          <div className="mb-3 flex items-center justify-between text-xs text-l3">
            <span>欢迎使用 Mesa · 三步上手</span>
            <span role="status">已完成 {progress.doneCount} / {progress.total}</span>
          </div>
          <Progress current={view} steps={progress.steps} onPick={setView} disabled={busy} />
          <h1 id="onboarding-title" ref={headingRef} tabIndex={-1} className="mt-10 text-2xl font-semibold tracking-tight text-l1 outline-none">{step.headline}</h1>
          <p id="onboarding-summary" className="mt-2 text-sm leading-6 text-l3">{step.summary}</p>
          <div key={view} data-wizard-content aria-busy={busy} className="ccode-fade mt-6">
            {view === "connect" && <ConnectScreen facts={facts} onBusyChange={setBusy} />}
            {view === "chat" && <ChatScreen done={viewDone} connected={facts.profileCount > 0} onConnect={() => setView("connect")} close={close} />}
            {view === "project" && <ProjectScreen done={viewDone} close={close} />}
          </div>
        </div>
      </main>

      {/* 发丝线贯通整窗：内容滚到底栏下面时有个边，不像被截断 */}
      <footer className="shrink-0 border-t border-hairline text-xs">
        <div className="mx-auto flex w-full max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3">
          {!retired && <div className="-ml-3 flex items-center gap-1">
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
          </div>}
          <p className="min-w-0 flex-1 truncate text-l4" role="status">
            {busy ? "正在处理，请稍候…" : retired ? "引导已收起，只在「帮助 → 上手引导」里" : "随时可从「帮助 → 上手引导」回来"}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {index > 0 && (
              <button type="button" className={`${secondaryActionClass} gap-1.5`} disabled={busy} onClick={() => setView(ONBOARDING_STEPS[index - 1]!.id)}>
                <ArrowLeft size={13} aria-hidden="true" />
                上一步
              </button>
            )}
            {last ? (
              <button type="button" className={primaryActionClass} onClick={close}>
                {progress.doneCount === progress.total ? "完成" : retired ? "关闭" : "先去体验"}
              </button>
            ) : (
              <button
                type="button"
                className={`${viewDone ? primaryActionClass : quietActionClass} gap-1.5`}
                disabled={busy}
                onClick={() => setView(ONBOARDING_STEPS[index + 1]!.id)}
              >
                {viewDone ? "下一步" : "跳过这步"}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </footer>
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
  // 一行横向步进：圆点 + 名字，步与步之间一条细线（前一步做完线着成功色），三步全在一眼之内
  return (
    <ol className="-ml-1 -mr-3 flex items-center" aria-label="上手步骤">
      {steps.map(({ step, done }, i) => {
        const isCurrent = step.id === current;
        return (
          <li key={step.id} className={`flex min-w-0 items-center ${i > 0 ? "flex-1" : "shrink-0"}`}>
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`mx-2 h-px min-w-4 flex-1 transition-colors ${steps[i - 1]!.done ? "bg-ok-text/50" : "bg-hairline"}`}
              />
            )}
            <button
              type="button"
              onClick={() => onPick(step.id)}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${step.title}，${done ? "已完成" : isCurrent ? "当前步骤" : "未完成"}`}
              disabled={disabled}
              className="group flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums transition-colors ${
                  isCurrent
                    ? "bg-cta font-medium text-cta-text"
                    : done
                      ? "bg-field text-ok-text"
                      : "bg-field text-l3"
                }`}
              >
                {done ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : i + 1}
              </span>
              <span className={`whitespace-nowrap text-xs ${isCurrent ? "font-medium text-l1" : done ? "text-l2 group-hover:text-l1" : "text-l3 group-hover:text-l2"}`}>
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

function SuccessCard({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="flex items-start gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-field text-ok-text">
        <Check size={12} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <div role="status">
        <p className="text-sm font-medium text-l1">{title}</p>
        {detail && <p className="mt-0.5 text-xs leading-5 text-l3">{detail}</p>}
      </div>
    </Card>
  );
}

/* ---------- 第一屏：接上 AI ---------- */

function ConnectScreen({ facts, onBusyChange }: { facts: OnboardingFacts; onBusyChange: (busy: boolean) => void }) {
  const stage = connectStage(facts);
  const profiles = useAppStore((s) => s.profiles);
  // 做完了回来看：结果在上，原来的接入流程收在「再接一个」里，点开还能照样走一遍
  const [again, setAgain] = useState(false);
  if (stage === "done") {
    const names = profiles.map((p) => `${labelOf(p.agent)} · ${p.name}`);
    return (
      <div className="space-y-4">
        <SuccessCard
          title={profiles.length > 1 ? `已添加 ${profiles.length} 条连接` : `${labelOf(profiles[0]?.agent ?? "")} 连接已添加`}
          detail={`${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}。下一步发一句话，确认 AI 能正常回复。`}
        />
        {again ? (
          facts.installedAgents.length ? (
            <ChooseStage facts={facts} onBusyChange={onBusyChange} onDone={() => setAgain(false)} />
          ) : (
            <InstallStage onBusyChange={onBusyChange} />
          )
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button type="button" className={`${secondaryActionClass} gap-1.5`} onClick={() => setAgain(true)}>
              <Plus size={13} aria-hidden="true" />
              再接一个
            </button>
            <span className="text-l3">换一家 Agent、另一个服务商，或改用官方账号</span>
          </div>
        )}
      </div>
    );
  }
  return stage === "install" ? <InstallStage onBusyChange={onBusyChange} /> : <ChooseStage facts={facts} onBusyChange={onBusyChange} />;
}

function InstallStage({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const install = useAgentInstall();
  const depCheck = useAppStore((s) => s.depCheck);
  const refreshDepCheck = useAppStore((s) => s.refreshDepCheck);
  const [showOthers, setShowOthers] = useState(false);
  const [nodeFor, setNodeFor] = useState<string | null>(null);
  const nodeForRef = useRef<string | null>(null);
  nodeForRef.current = nodeFor;
  const depInstall = useDepInstall((_tool, res) => {
    if (!res.ok) return;
    void refreshDepCheck();
    const pending = nodeForRef.current;
    setNodeFor(null);
    // Node 装好后接着走刚才那家的安装；先刷新命令预览再装
    if (pending) void install.loadPreviews([pending]).then(() => install.install(pending));
  });
  const installing = Object.values(install.entries).some((entry) => entry.running) || depInstall.entries.node.running;
  useEffect(() => {
    onBusyChange(installing);
    return () => onBusyChange(false);
  }, [installing, onBusyChange]);
  const openProxySettings = () => {
    const s = useAppStore.getState();
    s.setOnboardingWizardOpen(false);
    s.setSettingsSectionReq("network");
    s.setPage("settings");
  };
  const others = useMemo(() => AGENTS.filter((a) => !(RECOMMENDED as readonly string[]).includes(a.id)), []);
  const ids = useMemo(() => AGENTS.map((a) => a.id as string), []);
  useEffect(() => {
    void install.loadPreviews(ids);
    if (!useAppStore.getState().depCheck) void refreshDepCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function row(id: string, recommended: boolean) {
    const entry = install.entries[id];
    const method = install.previews[id];
    const noTool = method === null;
    const hint = entry?.result && !entry.result.ok ? diagnose(entry.result.output, entry.result.method, IS_WINDOWS) : null;
    return (
      <Card key={id} className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-l1">{labelOf(id)}</p>
            {recommended && BLURB[id] && <p className="mt-0.5 text-xs text-l3">{BLURB[id]}</p>}
          </div>
          <button
            type="button"
            className={secondaryActionClass}
            disabled={installing || method === undefined}
            onClick={() => {
              if (noTool) {
                setNodeFor(id);
                return;
              }
              void install.install(id);
            }}
          >
            {entry?.running ? "安装中…" : method === undefined ? "检查中…" : entry?.result && !entry.result.ok ? "重试" : "安装"}
          </button>
        </div>
        {method && !entry?.running && !entry?.result && (
          <p className="break-all rounded-md bg-field px-2.5 py-2 font-mono text-micro leading-5 text-l3">将执行：{method}</p>
        )}
        {noTool && nodeFor !== id && <p className="text-xs leading-5 text-l3">这台电脑缺少安装工具，点「安装」看怎么补。</p>}
        {noTool && nodeFor === id && (
          <div className="space-y-2">
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
                {!depInstall.entries.node.running && <span className="text-xs text-l3">装好后接着安装 {labelOf(id)}</span>}
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
            className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 font-mono text-micro text-l3"
          >
            {entry.output.trim() || "安装中，等待输出…"}
          </pre>
        )}
        {entry?.result && !entry.result.ok && !entry.running && (
          <div className="space-y-1">
            <p className="text-xs text-err-text">安装失败</p>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 font-mono text-micro text-l3">
              {entry.result.output.trim().slice(-1200)}
            </pre>
            {hint && <p className="text-xs leading-5 text-l3">{hint}</p>}
            <p className="text-xs leading-5 text-l3">
              下载慢或连不上，多半是网络问题：
              <button type="button" className="ml-1 text-cta hover:underline" disabled={installing} onClick={openProxySettings}>
                去设置出网代理
              </button>
              ，填好再点「重试」。
            </p>
          </div>
        )}
      </Card>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <p className="text-xs leading-5 text-l3">先选一个安装，之后可以添加其他 Agent。</p>
      {RECOMMENDED.map((id) => row(id, true))}
      <button type="button" className={`${quietActionClass} -ml-3 gap-1.5`} aria-expanded={showOthers} aria-controls="onboarding-other-agents" onClick={() => setShowOthers((v) => !v)}>
        {showOthers ? "收起其他 Agent" : "其他 Agent…"}
        <ChevronDown size={13} className={showOthers ? "rotate-180" : ""} aria-hidden="true" />
      </button>
      {showOthers && <div id="onboarding-other-agents" className="space-y-3">{others.map((a) => row(a.id, false))}</div>}
      <p className="text-xs leading-5 text-l3">
        下载慢或连不上？
        <button type="button" className="ml-1 text-cta hover:underline" disabled={installing} onClick={openProxySettings}>
          去设置出网代理
        </button>
      </p>
      <p className="pt-1 text-xs leading-5 text-l3">
        已经在终端里装好了？装好后回到这里，向导会自动认出来。
      </p>
    </div>
  );
}

function ChooseStage({
  facts,
  onBusyChange,
  onDone = () => {},
}: {
  facts: OnboardingFacts;
  onBusyChange: (busy: boolean) => void;
  /** 接好一条（「再接一个」时收起流程用） */
  onDone?: () => void;
}) {
  const setOpen = useAppStore((s) => s.setOnboardingWizardOpen);
  const official = useAppStore((s) => s.onboardingOfficial);
  const installed = facts.installedAgents;
  const defaultAgent = facts.officialReady?.[0] ?? installed[0]!;
  const [picked, setPicked] = useState(defaultAgent);
  const agent = installed.includes(picked) ? picked : defaultAgent;
  const probe = official[agent];
  const [method, setMethod] = useState<"official" | "key" | null>(null);
  const active = method ?? (probe === "ready" || probe === "login" ? "official" : "key");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  function openGatewayLibrary() {
    const s = useAppStore.getState();
    setOpen(false);
    s.setPage("profiles");
    s.setGatewayLibraryReq({ token: Date.now(), create: true });
  }

  return (
    <div className="space-y-4">
      {/* 只装了一家就直说装好了；装了几家给一排选择（按钮上的字号写在容器上：全站 button 的 font: inherit 会吞掉按钮自己的 text-*） */}
      {installed.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
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
              className={`flex h-7 items-center gap-1 rounded-full border px-2.5 transition-colors ${
                id === agent ? "border-cta bg-cta/10 font-medium text-l1" : "border-hairline text-l3 hover:bg-hover hover:text-l1"
              }`}
            >
              {id === agent && <Check size={12} strokeWidth={2.4} className="text-cta" aria-hidden="true" />}
              {labelOf(id)}
            </button>
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-l2"><Check size={14} className="text-ok-text" aria-hidden="true" />{labelOf(agent)} 已装好</p>
      )}

      {probe === undefined && (
        <Card><p role="status" className="text-sm text-l3">正在检查官方账号登录状态…</p></Card>
      )}

      {(probe === "ready" || probe === "login") && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="接入方式">
          {(
            [
              ["official", "官方账号", `登录 ${labelOf(agent)} 自家账号`],
              ["key", "服务商 API Key", "服务商或中转站的地址和密钥，按量计费"],
            ] as const
          ).map(([id, label, hint]) => (
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
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  active === id ? "border-cta bg-cta" : "border-l4"
                }`}
              >
                {active === id && <span className="h-1.5 w-1.5 rounded-full bg-cta-text" />}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm ${active === id ? "font-medium text-l1" : "text-l2"}`}>{label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-l3">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {active === "official" && probe === "ready" && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-l1">官方账号已登录</p>
          <p className="text-xs leading-5 text-l3">直接使用现有账号接入。</p>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void connectOfficialAccount(agent)
                .then((ok) => {
                  if (ok) onDone();
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "接入中…" : officialShortcutLabel(labelOf(agent))}
          </button>
        </Card>
      )}
      {active === "official" && probe === "login" && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-l1">先登录 {labelOf(agent)} 官方账号</p>
          <p className="text-xs leading-5 text-l3">在终端按提示登录，再回到上手引导接入。</p>
          <button
            type="button"
            className={primaryActionClass}
            onClick={() => {
              setOpen(false);
              void startOfficialLogin(agent);
            }}
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
        <Card>
          <GatewayQuickForm key={agent} agent={agent} onConnected={onDone} onMore={openGatewayLibrary} onBusyChange={setBusy} />
        </Card>
      )}
    </div>
  );
}

/* ---------- 第二屏：聊第一句 ---------- */

const SAMPLE_PROMPT = "用三句话介绍你能帮我做什么。";

function ChatScreen({ done, connected, onConnect, close }: { done: boolean; connected: boolean; onConnect: () => void; close: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!connected) return (
    <Card className="space-y-3">
      <p className="text-sm font-medium text-l1">先添加一条 AI 连接</p>
      <p className="text-xs leading-5 text-l3">接好账号或密钥后，就能开始第一段对话。</p>
      <button type="button" className={primaryActionClass} onClick={onConnect}>去接上 AI</button>
    </Card>
  );
  return (
    <div className="space-y-4">
      {done && <SuccessCard title="已经聊过了" detail="第一段对话在侧栏「随手聊」里。想再试一次，照下面再开一段。" />}
      <Card className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-l1"><MessageSquare size={16} aria-hidden="true" />试着问 AI</div>
        <div className="flex items-center gap-3 rounded-lg bg-field py-3 pl-4 pr-2 text-xs">
          <p className="min-w-0 flex-1 text-sm leading-6 text-l2">{SAMPLE_PROMPT}</p>
          <button
            type="button"
            className={`${quietActionClass} shrink-0 gap-1.5`}
            onClick={() => {
              void navigator.clipboard.writeText(SAMPLE_PROMPT).then(() => setCopied(true), () => {});
            }}
          >
            {copied ? <Check size={13} className="text-ok-text" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <p className="text-xs leading-5 text-l3">打开对话后粘贴这句话发出去，有回复就说明接通了。</p>
        <button
          type="button"
          className={primaryActionClass}
          onClick={() => {
            close();
            void openQuickChat();
          }}
        >
          {done ? "再开一段对话" : "开始第一段对话"}
        </button>
      </Card>
      <details className="rounded-lg px-1 text-xs text-l3">
        <summary className="cursor-pointer py-2 hover:text-l1">聊天与终端、自动标题</summary>
        <div className="mt-2 space-y-3 leading-5">
          <p className="flex items-start gap-2"><Terminal size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span>运行页右上角的 {">_"} 可切到同一段对话的终端，查看命令与完整输出。</span></p>
          <p>标题由 AI 自动起，会用少量 token；可右键重命名，或在「设置 → AI 与 Agent」关闭「会话自动命名」。</p>
        </div>
      </details>
    </div>
  );
}

/* ---------- 第三屏：建第一个项目 ---------- */

function ProjectScreen({ done, close }: { done: boolean; close: () => void }) {
  const go = (run: (s: ReturnType<typeof useAppStore.getState>) => void) => {
    const s = useAppStore.getState();
    close();
    s.setPage("workspaces");
    run(s);
  };
  const actions = [
    { label: "新建项目", hint: "从空文件夹开始，选择工作方式", icon: FolderPlus, run: (s: ReturnType<typeof useAppStore.getState>) => s.setNewProjectOpenReq({ token: Date.now() }) },
    { label: "添加已有文件夹", hint: "把已有课题或代码文件夹加进来", icon: FolderOpen, run: (s: ReturnType<typeof useAppStore.getState>) => s.setAddProjectOpenReq(Date.now()) },
    { label: "创建示例课题", hint: "用示例体验科研流程", icon: FlaskConical, run: (s: ReturnType<typeof useAppStore.getState>) => s.setDemoProjectOpenReq(Date.now()) },
  ];
  return (
    <div className="space-y-3">
      {done && <SuccessCard title="项目建好了" detail="在侧栏「项目」下面点它，就能开始做课题；在它下面开的对话也列在它名下。还想再建，照下面选。" />}
      {actions.map((action) => (
        <button key={action.label} type="button" onClick={() => go(action.run)} className="ccode-well group flex w-full items-center gap-4 rounded-xl p-5 text-left transition-colors hover:bg-hover" aria-label={action.label}>
          <action.icon size={20} className="shrink-0 text-l3" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-l1">{action.label}</span>
            <span className="mt-1 block text-xs leading-5 text-l3">{action.hint}</span>
          </span>
          <ArrowRight size={16} className="shrink-0 text-l3 group-hover:text-l1" aria-hidden="true" />
        </button>
      ))}
      {!done && <p className="text-xs leading-5 text-l3">也可以稍后从侧栏「新项目」创建。</p>}
    </div>
  );
}
