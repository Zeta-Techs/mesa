import { useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../store";
import { dismissToast, toast } from "../toast";
import { AGENTS } from "../types";
import { probeOfficial } from "../connect-official";
import {
  completionNotice,
  decideInitialStatus,
  doneStepIds,
  newlyDone,
  onboardingProgress,
  stepById,
  tipsNotice,
  type OnboardingFacts,
  type OnboardingStepId,
} from "../onboarding";
import { OnboardingWizard } from "./OnboardingWizard";

/**
 * 上手引导的外壳（2026-10-29 改全屏向导后）：首次判定与自动弹出、官方账号探测、步骤完成后的右下角提示、
 * 侧栏进度行用的 hook 与进度环。向导本体在 OnboardingWizard.tsx，完成判定与文案在 onboarding.ts。
 */

/** 完成提示 / 小提示共用的 key：新的一条顶掉旧的，收起引导时一并撤掉 */
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
  const official = useAppStore((s) => s.onboardingOfficial);
  return useMemo(() => {
    if (agents.length === 0) return null;
    const installed = new Set(agents.filter((a) => a.binaryPath).map((a) => a.id));
    return {
      installedAgents: AGENTS.map((a) => a.id as string).filter((id) => installed.has(id)),
      gatewayCount,
      profileCount,
      userSessionCount: sessions.filter((session) => !session.internal).length,
      projectCount,
      officialReady: Object.keys(official).filter((id) => official[id] === "ready"),
    };
  }, [agents, gatewayCount, profileCount, sessions, projectCount, official]);
}

/** 帮助菜单 / 命令面板「上手引导」：弹出向导。点过「不再显示」的只是回来看看，不把侧栏那一行和右下角提示
 *  重新招回来（2026-10-29 用户：引导没用了要能手动永远关掉）；还没判定过的照常进入引导 */
export function openOnboardingGuide() {
  const s = useAppStore.getState();
  if (s.onboarding.status === "unset") {
    s.updateOnboarding({ status: "active", welcomed: true });
  }
  s.setOnboardingWizardOpen(true);
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
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-cta">
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

/** 侧栏「上手引导」行要的数据；引导没在进行（或数据还没到）返回 null，侧栏就不画这一行 */
export function useOnboardingRail(): {
  done: number;
  total: number;
  next: string | null;
  open: boolean;
} | null {
  const facts = useOnboardingFacts();
  const state = useAppStore((s) => s.onboarding);
  const open = useAppStore((s) => s.onboardingWizardOpen);
  if (!facts || state.status !== "active") return null;
  const progress = onboardingProgress(facts);
  return {
    done: progress.doneCount,
    total: progress.total,
    next: progress.current ? stepById(progress.current).title : null,
    open,
  };
}

/**
 * 挂在 App 根部：首次判定、向导自动弹出、官方账号探测、步骤完成后的提示。
 * ready = 首屏数据（连接 / 会话 / 项目）都到齐了——没到齐时判定会把老用户当新人、
 * 把陆续到达的数据当成「刚做完」。
 */
export function OnboardingHost({ ready }: { ready: boolean }) {
  const facts = useOnboardingFacts();
  const state = useAppStore((s) => s.onboarding);
  const wizardOpen = useAppStore((s) => s.onboardingWizardOpen);
  const updateOnboarding = useAppStore((s) => s.updateOnboarding);

  useEffect(() => {
    if (!ready || !facts || state.status !== "unset") return;
    const status = decideInitialStatus(facts);
    updateOnboarding({ status, welcomed: status !== "active" });
  }, [ready, facts, state.status, updateOnboarding]);

  // 新装第一次：自动弹出向导（只弹一次，关掉也算看过）
  useEffect(() => {
    if (!ready || state.status !== "active" || state.welcomed) return;
    updateOnboarding({ welcomed: true });
    useAppStore.getState().setOnboardingWizardOpen(true);
  }, [ready, state.status, state.welcomed, updateOnboarding]);

  // 引导进行中、还没有连接时，探测已装 Agent 的官方账号登录状态（只读 auth 文件）；向导开着也探
  // （接好之后回来点「再接一个」要用）。窗口回前台再探一次，在终端里登录完回来就能认出来
  const probeKey =
    ready && facts && (wizardOpen || (state.status === "active" && facts.profileCount === 0))
      ? facts.installedAgents.join(",")
      : null;
  useEffect(() => {
    const setOfficial = useAppStore.getState().setOnboardingOfficial;
    if (probeKey === null) {
      setOfficial({});
      return;
    }
    if (!probeKey) return;
    let cancelled = false;
    const run = () => {
      void probeOfficial(probeKey.split(",")).then((probe) => {
        if (!cancelled) setOfficial(probe);
      });
    };
    run();
    window.addEventListener("focus", run);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", run);
    };
  }, [probeKey]);

  const prevDone = useRef<OnboardingStepId[] | null>(null);
  useEffect(() => {
    if (!ready || !facts) return;
    const progress = onboardingProgress(facts);
    const done = doneStepIds(progress);
    const prev = prevDone.current;
    prevDone.current = done;
    // 第一次只记基线；引导没在进行时做完的步骤不提示
    if (!prev || state.status !== "active") return;
    const fresh = newlyDone(prev, done);
    if (!fresh.length) return;
    if (progress.current === null) {
      dismissToast(TOAST_KEY);
      useAppStore.getState().setOnboardingWizardOpen(false);
      toast(completionNotice("project", null).text, "success");
      updateOnboarding({ status: "done" });
      return;
    }
    if (fresh.includes("chat")) {
      // 第一段对话出现：讲终端和标题两个小提示（讲过就不再弹）
      const tips = tipsNotice(state.acks);
      if (tips) {
        useAppStore.getState().updateOnboarding({ acks: { terminal: true, naming: true } });
        toast(tips, "info", { key: TOAST_KEY, sticky: true, actions: [{ label: "知道了", onClick: () => dismissToast(TOAST_KEY), primary: true }] });
        return;
      }
    }
    // 向导开着时界面自己就在展示结果，不再另弹
    if (useAppStore.getState().onboardingWizardOpen) return;
    const notice = completionNotice(fresh[fresh.length - 1]!, progress.current, {
      installedLabel: labelOf(facts.installedAgents[0]),
    });
    toast(notice.text, notice.tone, {
      key: TOAST_KEY,
      sticky: true,
      actions: [
        {
          label: "打开上手引导",
          onClick: () => {
            dismissToast(TOAST_KEY);
            useAppStore.getState().setOnboardingWizardOpen(true);
          },
          primary: true,
        },
      ],
    });
  }, [ready, facts, state, updateOnboarding]);

  // 收起或完成后，残留的提示一并撤掉
  useEffect(() => {
    if (state.status !== "active") dismissToast(TOAST_KEY);
  }, [state.status]);

  // 向导打开时撤掉残留的「下一步」提示
  useEffect(() => {
    if (wizardOpen) dismissToast(TOAST_KEY);
  }, [wizardOpen]);

  if (!facts) return null;
  return <OnboardingWizard facts={facts} />;
}
