import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check } from "lucide-react";
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
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function OnboardingWizard({ facts }: { facts: OnboardingFacts }) {
  const open = useAppStore((s) => s.onboardingWizardOpen);
  const setOpen = useAppStore((s) => s.setOnboardingWizardOpen);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);
  const light = isLightTheme(useAppStore((s) => s.settings?.theme));
  const macFullscreen = useMacFullscreen(IS_MAC);
  const { render, exiting } = useExitRender(open);
  const progress = onboardingProgress(facts);
  const [view, setView] = useState<OnboardingStepId>("connect");
  const rootRef = useRef<HTMLDivElement>(null);

  // 每次打开落在第一个没做完的一屏
  useEffect(() => {
    if (open) setView(progress.current ?? "project");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => setOpen(false);
  const index = ONBOARDING_STEPS.findIndex((s) => s.id === view);
  const last = index === ONBOARDING_STEPS.length - 1;
  const viewDone = progress.steps[index]?.done ?? false;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusable = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      rootRef.current?.querySelector("[data-wizard-content]")?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, setOpen]);

  if (!render) return null;
  const step = stepById(view);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="上手引导"
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

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col px-6 pb-8 pt-[7vh]">
          <Progress current={view} steps={progress.steps} onPick={setView} />
          <h1 className="mt-9 text-2xl font-semibold text-l1">{step.headline}</h1>
          <p className="mt-2 text-sm leading-6 text-l3">{step.summary}</p>
          <div key={view} data-wizard-content className="ccode-fade mt-7">
            {view === "connect" && <ConnectScreen facts={facts} />}
            {view === "chat" && <ChatScreen done={viewDone} close={close} />}
            {view === "project" && <ProjectScreen done={viewDone} close={close} />}
          </div>
        </div>
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline px-6 py-3">
        <div className="flex items-center gap-1">
          <button type="button" className={quietActionClass} onClick={close}>
            稍后再说
          </button>
          <button
            type="button"
            className="h-8 rounded-md px-2 text-xs text-l4 transition-colors hover:text-l2"
            title="侧栏的上手引导行一并收起；想再看，到顶栏「帮助 → 上手引导」"
            onClick={() => {
              updateOnboarding({ status: "dismissed" });
              close();
            }}
          >
            不再显示
          </button>
        </div>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button type="button" className={secondaryActionClass} onClick={() => setView(ONBOARDING_STEPS[index - 1]!.id)}>
              上一步
            </button>
          )}
          {last ? (
            <button type="button" className={primaryActionClass} onClick={close}>
              完成
            </button>
          ) : (
            <button
              type="button"
              className={viewDone ? primaryActionClass : secondaryActionClass}
              onClick={() => setView(ONBOARDING_STEPS[index + 1]!.id)}
            >
              {viewDone ? "下一步" : "跳过这步"}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** 顶部进度：三个圈用线串起来；做完 = 勾，当前 = 琥珀实心，其余发丝描边；可点着回看 */
function Progress({
  current,
  steps,
  onPick,
}: {
  current: OnboardingStepId;
  steps: { step: { id: OnboardingStepId; title: string }; done: boolean }[];
  onPick: (id: OnboardingStepId) => void;
}) {
  return (
    <ol className="flex items-center">
      {steps.map(({ step, done }, i) => {
        const isCurrent = step.id === current;
        return (
          <li key={step.id} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => onPick(step.id)}
              aria-current={isCurrent ? "step" : undefined}
              className="group flex items-center gap-2 rounded-md py-1 text-left"
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro tabular-nums transition-colors ${
                  isCurrent
                    ? "bg-cta font-medium text-cta-text"
                    : done
                      ? "bg-field text-ok-text"
                      : "border border-hairline text-l4"
                }`}
              >
                {done && !isCurrent ? <Check size={12} strokeWidth={2.4} aria-hidden="true" /> : i + 1}
              </span>
              <span className={`text-xs ${isCurrent ? "font-medium text-l1" : "text-l3 group-hover:text-l2"}`}>
                {step.title}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span className={`mx-3 h-px flex-1 ${done ? "bg-ok-text/40" : "bg-hairline"}`} aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ccode-card rounded-lg border border-hairline p-4 ${className}`}>{children}</div>;
}

function SuccessCard({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="flex items-start gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-field text-ok-text">
        <Check size={12} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-medium text-l1">{title}</p>
        {detail && <p className="mt-0.5 text-xs leading-5 text-l3">{detail}</p>}
      </div>
    </Card>
  );
}

/* ---------- 第一屏：接上 AI ---------- */

function ConnectScreen({ facts }: { facts: OnboardingFacts }) {
  const stage = connectStage(facts);
  const profiles = useAppStore((s) => s.profiles);
  if (stage === "done") {
    const first = profiles[0];
    return (
      <SuccessCard
        title={first ? `${labelOf(first.agent)} 已接通` : "已接通"}
        detail="连接已经加好。下一步发一句话，确认真的能用。"
      />
    );
  }
  return stage === "install" ? <InstallStage /> : <ChooseStage facts={facts} />;
}

function InstallStage() {
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
            className={recommended ? primaryActionClass : secondaryActionClass}
            disabled={entry?.running || method === undefined}
            onClick={() => {
              if (noTool) {
                setNodeFor(id);
                return;
              }
              void install.install(id);
            }}
          >
            {entry?.running ? "安装中…" : noTool ? "安装" : entry?.result && !entry.result.ok ? "重试" : "安装"}
          </button>
        </div>
        {method && !entry?.running && !entry?.result && (
          <p className="break-all font-mono text-micro leading-4 text-l4">将执行：{method}</p>
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
              <button type="button" className="ml-1 text-cta hover:underline" onClick={openProxySettings}>
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
    <div className="space-y-3">
      <p className="text-xs leading-5 text-l3">
        没有偏好就从 Claude Code 或 Codex 开始。安装要联网下载；国内网络慢或失败，先到 设置 → 网络 填出网代理（如 http://127.0.0.1:7890）。
        <button type="button" className="ml-1 text-cta hover:underline" onClick={openProxySettings}>
          去设置出网代理
        </button>
      </p>
      {RECOMMENDED.map((id) => row(id, true))}
      <button type="button" className="text-xs text-l3 hover:text-l1" onClick={() => setShowOthers((v) => !v)}>
        {showOthers ? "收起其他 Agent" : "其他 Agent…"}
      </button>
      {showOthers && <div className="space-y-3">{others.map((a) => row(a.id, false))}</div>}
      <p className="pt-1 text-xs leading-5 text-l4">
        已经在终端里装好了？装好后回到这里，向导会自动认出来。
      </p>
    </div>
  );
}

function ChooseStage({ facts }: { facts: OnboardingFacts }) {
  const setOpen = useAppStore((s) => s.setOnboardingWizardOpen);
  const official = useAppStore((s) => s.onboardingOfficial);
  const installed = facts.installedAgents;
  const defaultAgent = facts.officialReady?.[0] ?? installed[0]!;
  const [picked, setPicked] = useState<string | null>(null);
  const agent = picked && installed.includes(picked) ? picked : defaultAgent;
  const probe = official[agent];
  const [method, setMethod] = useState<"official" | "key" | null>(null);
  const active = method ?? (probe === "ready" || probe === "login" ? "official" : "key");
  const [busy, setBusy] = useState(false);

  function openGatewayLibrary() {
    const s = useAppStore.getState();
    setOpen(false);
    s.setPage("profiles");
    s.setGatewayLibraryReq({ token: Date.now(), create: true });
  }

  return (
    <div className="space-y-4">
      {installed.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-l3">用哪家：</span>
          {installed.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setPicked(id);
                setMethod(null);
              }}
              className={`h-7 rounded-md border px-2.5 text-xs transition-colors ${
                id === agent ? "border-cta text-l1" : "border-hairline text-l3 hover:text-l1"
              }`}
            >
              {labelOf(id)}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-l2">{labelOf(agent)} 已装好。怎么连上 AI？</p>

      {(probe === "ready" || probe === "login") && (
        <div className="flex gap-1 rounded-md bg-field p-0.5 text-xs">
          {(
            [
              ["official", "官方账号"],
              ["key", "服务商 API Key"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMethod(id)}
              className={`h-7 flex-1 rounded transition-colors ${
                active === id ? "bg-raised font-medium text-l1" : "text-l3 hover:text-l1"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {active === "official" && probe === "ready" && (
        <Card className="space-y-3">
          <p className="text-sm leading-6 text-l2">
            检测到你已经登录了 {labelOf(agent)} 官方账号，直接接入就行，不用建网关，也不用再登录。
          </p>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void connectOfficialAccount(agent).finally(() => setBusy(false));
            }}
          >
            {busy ? "接入中…" : officialShortcutLabel(labelOf(agent))}
          </button>
        </Card>
      )}
      {active === "official" && probe === "login" && (
        <Card className="space-y-3">
          <p className="text-sm leading-6 text-l2">
            {labelOf(agent)} 官方账号还没登录。点下面打开终端按提示登录（浏览器里点确认就行），登录好回到「上手引导」，一键接入。
          </p>
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
      {active === "key" && probe !== undefined && (
        <Card>
          <GatewayQuickForm key={agent} agent={agent} onConnected={() => {}} onMore={openGatewayLibrary} />
        </Card>
      )}
      {probe === "none" && (
        <p className="text-xs leading-5 text-l4">
          {labelOf(agent)} 没有官方账号登录方式，用服务商给你的 API Key 接入。
        </p>
      )}
    </div>
  );
}

/* ---------- 第二屏：聊第一句 ---------- */

function ChatScreen({ done, close }: { done: boolean; close: () => void }) {
  if (done) return <SuccessCard title="已经聊过了" detail="第一段对话在侧栏「随手聊」里。接下来可以建项目。" />;
  return (
    <Card className="space-y-3">
      <p className="text-sm leading-6 text-l2">点下面开一段新对话，写一句话发出去，比如「用三句话介绍你能帮我做什么」。</p>
      <ul className="space-y-1.5 text-xs leading-5 text-l3">
        <li>
          · 聊天底下跑的就是这家 Agent 的命令行（CLI）：运行页右上角的 {">_"} 图标能切到同一段对话的终端，看 AI 实际运行的命令，不会另开对话。
        </li>
        <li>
          · 对话标题由 AI 自动起（会用掉少量 token）；想自己改就右键重命名，不想自动起名，到 设置 → AI 与 Agent 关掉「会话自动命名」。
        </li>
        <li>· 报错时按提示回连接页改地址、密钥或模型；向导会留在侧栏「上手引导」里，随时回来。</li>
      </ul>
      <button
        type="button"
        className={primaryActionClass}
        onClick={() => {
          close();
          void openQuickChat();
        }}
      >
        开始第一段对话
      </button>
    </Card>
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
  if (done) return <SuccessCard title="项目建好了" detail="在侧栏「项目」下面点它，就能开始做课题；在它下面开的对话也列在它名下。" />;
  const actions: { label: string; hint: string; primary?: boolean; run: (s: ReturnType<typeof useAppStore.getState>) => void }[] = [
    { label: "新建项目", hint: "起名、选位置和工作方式（科研 / 编程 / 工作）", primary: true, run: (s) => s.setNewProjectOpenReq({ token: Date.now() }) },
    { label: "添加已有文件夹", hint: "已经有课题文件夹，登记进来就行", run: (s) => s.setAddProjectOpenReq(Date.now()) },
    { label: "创建示例课题", hint: "只想先看看科研流程长什么样", run: (s) => s.setDemoProjectOpenReq(Date.now()) },
  ];
  return (
    <div className="space-y-3">
      {actions.map((a) => (
        <Card key={a.label} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-l1">{a.label}</p>
            <p className="mt-0.5 text-xs text-l3">{a.hint}</p>
          </div>
          <button type="button" className={a.primary ? primaryActionClass : secondaryActionClass} onClick={() => go(a.run)}>
            {a.label}
          </button>
        </Card>
      ))}
      <p className="text-xs leading-5 text-l4">不急的话，点右下角「完成」，之后随时在侧栏「项目」旁的 ＋ 里建。</p>
    </div>
  );
}
