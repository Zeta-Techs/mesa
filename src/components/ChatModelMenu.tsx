import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronLeft, ChevronRight, History, Info } from "lucide-react";
import { AGENTS } from "../types";
import type { DetectResult, ModelCapabilityDto } from "../types";
import { useAppStore } from "../store";
import { useMenuKeyNav } from "../menu-key-nav";
import { useRuntimeModelEffort } from "../runtime-model-effort";
import { connectionModels, readModelHistory } from "../model-history";
import { nonChatReason } from "../model-kinds";
import { modelCapsLabel } from "../model-caps-label";
import { clipBounds, pickPopoverSide, popoverRoom } from "../popover-side";
import ContextRing from "./ContextRing";
import EffortMark from "./EffortMark";
import { effortDepth, effortGloss } from "../effort-depth";
import { agentBrand } from "../agent-colors";
import type { LaunchCombo } from "../launch-combos";
import { breakdownRequest } from "../context-breakdown";
import type {
  LaunchPickState,
  NativePermissionMode,
  TabStatus,
} from "../pages/TerminalPage";

/** 进程已退出、还能接着聊时：选「接着聊用哪个模型 / 思考档」（写标签的启动选择，下次启动生效） */
export interface NextLaunchPick {
  models: string[];
  model: string;
  onModel: (model: string) => void;
  effortLevels: string[];
  effort: string;
  onEffort: (level: string) => void;
}

type LaunchProps = {
  kind: "launch";
  pick: LaunchPickState;
  onAgent: (id: string) => void;
  onProfile: (id: string) => void;
  onModel: (model: string) => void;
  onEffort: (level: string) => void;
  onPermission: (permission: "discuss" | "write_tree", mode?: NativePermissionMode | null) => void;
  /** 「最近在这个项目用过」的搭配（launch-combos.ts；连接已删的调用方先滤掉） */
  combos?: LaunchCombo[];
  /** 搭配标题里的项目名 */
  combosWhere?: string | null;
  /** 点一套搭配：Agent + 连接 + 模型 + 思考档一起换 */
  onCombo?: (combo: LaunchCombo) => void;
} & SharedProps;

type SharedProps = {
  /** 输入框里有图：看不了图的模型在名单里标出来，当前模型看不了时经 onImageWarning 告诉输入框 */
  hasImages?: boolean;
  onImageWarning?: (warning: string | null) => void;
};

type RuntimeProps = {
  kind: "runtime";
  status: TabStatus | null;
  profileModels: string[];
  modelSwitch: DetectResult["modelSwitch"];
  effort: DetectResult["effort"];
  submitCsiU: boolean;
  onTuiCommand: (cmd: string) => void;
  /** 唤起 CLI 自己的选择器之后：露出下方终端（选择器可能很长，聊天层的确认卡不一定认得全） */
  onPicker?: () => void;
  next?: NextLaunchPick | null;
  /** 上一轮请求喂进去的 token（输入 + 缓存），画上下文用量圆环用；没有为 null */
  contextUsed?: number | null;
  /** 上下文浮层里的「压缩上下文」（斜杠面板 Mesa 组同一个动作；这家没有压缩命令或没在运行时不给） */
  onCompact?: (() => void) | null;
  /** 停下 Agent、带新模型 / 思考档接回原对话（会写回 CLI 全局配置的切换走这条，switch-strategy.ts） */
  onRelaunch?: (patch: { model?: string; effort?: string | null }) => void;
} & SharedProps;

/** 菜单最高多少（px）：大屏上也不一路拉长，名单多了在中间那段里滚 */
const MENU_CAP = 460;

/**
 * 聊天输入框右下的「模型 · 思考」菜单（docs/design-chat-layer.md §4.3）：开聊前、运行中、停了可接着聊三种情形
 * 同一个单栏菜单——顶部一行「Agent · 配置」（开聊前点进二级换），中间模型（名字下一行是能力灰字），下面思考强度滑块，
 * 底部只在需要时写一两行说明（完整原委在悬停提示）。行的样子与左下权限菜单同一套（2026-10-18 审美一轮）。原先开聊前是四栏宽弹层、开聊后是另一个窄菜单，用户要学两次（2026-10-17 用户确认第一期）。
 * 运行中的显示与切换和终端底栏同一份（runtime-model-effort.ts）；模型名以屏上读回为准，未读回标「待确认」。
 */
export default function ChatModelMenu(props: LaunchProps | RuntimeProps) {
  const launch = props.kind === "launch" ? props : null;
  const runtime = props.kind === "runtime" ? props : null;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "who">("main");
  const [customModel, setCustomModel] = useState("");
  // 手填的是出图 / 向量等不能对话的模型：不收，原因写在输入框下
  const [customErr, setCustomErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuKeyNav(menuRef, open, view);
  // 下面放得下就往下开（开聊前输入框在屏幕中间），贴底时往上（popover-side.ts，2026-10-18 用户）。
  // 两边都放不下时按那一边的空间限高，中间的名单区自己滚动，不再溢出窗口（2026-10-20 用户）
  const bodyRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"above" | "below">("above");
  const [room, setRoom] = useState(MENU_CAP);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const menu = menuRef.current;
      if (!rootRef.current || !menu) return;
      const anchor = rootRef.current.getBoundingClientRect();
      const body = bodyRef.current;
      // 已被限高时 offsetHeight 偏小：滚动区按内容全高补回来，才是「不限高要多高」
      const natural = menu.offsetHeight + (body ? body.scrollHeight - body.clientHeight : 0);
      // 边界按看得见的区域算（运行页在顶栏下面，按整个窗口算会顶出去被盖住）
      const bounds = clipBounds(rootRef.current);
      const s = pickPopoverSide(anchor, bounds, Math.min(natural, MENU_CAP));
      setSide(s);
      setRoom(popoverRoom(anchor, bounds, s, MENU_CAP));
    };
    place();
    // 打开时把当前选中的那一行滚进可视区（名单长、选的在后面时）
    const body = bodyRef.current;
    const selected = body?.querySelector<HTMLElement>('[data-selected="true"]');
    if (body && selected) {
      const top = selected.offsetTop; // 滚动区自带 relative，offsetTop 就是相对它的
      if (top + selected.offsetHeight > body.clientHeight) body.scrollTop = top - body.clientHeight / 2;
    }
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, view]);
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);

  const status = runtime?.status ?? null;
  const rt = useRuntimeModelEffort({
    status,
    profileId: status?.profileId ?? null,
    launchModel: status?.launchModel ?? null,
    modelSwitch: runtime?.modelSwitch ?? null,
    effort: runtime?.effort ?? null,
    submitCsiU: runtime?.submitCsiU ?? false,
    send: runtime?.onTuiCommand,
    relaunch: runtime?.onRelaunch,
  });
  // 换了要重开接回、而这一轮还在生成：先不让换（重开会打断这一轮）
  const relaunchWaiting = Boolean(runtime) && rt.relaunchBlocked && (rt.modelByRelaunch || rt.effortByRelaunch);

  useEffect(() => {
    if (!open) {
      setView("main");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const live = Boolean(status?.running && status.ptyId);
  const next = runtime && !live ? (runtime.next ?? null) : null;
  const agentId = launch ? launch.pick.agentId : (status?.agentId ?? "");
  const profileId = launch ? launch.pick.profileId : (status?.profileId ?? "");
  const agentLabel = AGENTS.find((a) => a.id === agentId)?.label ?? (agentId || "选择 Agent");
  const profile = profiles.find((p) => p.id === profileId);
  const profileLabel = launch
    ? (launch.pick.profiles.find((p) => p.value === profileId)?.label ?? "选择配置")
    : (profile?.name ?? "");

  // ---- 模型名单与当前模型（三种情形各取各的来源，名单同源 model-history.ts） ----
  let models: string[];
  let currentModel: string;
  if (launch) {
    models = launch.pick.models;
    currentModel = launch.pick.model.trim() || models[0] || "";
  } else if (next) {
    models = next.models;
    currentModel = next.model.trim() || models[0] || "";
  } else {
    const base = runtime?.profileModels ?? [];
    models = connectionModels(
      rt.shownModel && !base.includes(rt.shownModel) ? [rt.shownModel, ...base] : base,
      readModelHistory(agentId, status?.profileId),
    );
    currentModel = rt.shownModel;
  }
  // 能力灰字菜单打开才查；输入框里有图时也查（要知道当前模型能不能看图）
  const caps = useModelCaps(open || props.hasImages ? models : [], profile?.gatewayId ?? null);
  const hasImages = Boolean(props.hasImages);
  // 和当前选择一模一样的那套不列（列了也是点了没变化）
  const shownCombos = (launch?.combos ?? []).filter(
    (c) =>
      !(
        c.agentId === launch?.pick.agentId &&
        c.profileId === launch?.pick.profileId &&
        c.model === launch?.pick.model.trim() &&
        c.effort === launch?.pick.effort
      ),
  );
  const imageWarning =
    hasImages && currentModel && caps.vision[currentModel] === false
      ? `${currentModel} 看不了图：带图发出去会报错，这段对话之后也会接着报错。先移除图片，或换个能看图的模型`
      : null;
  const onImageWarning = props.onImageWarning;
  useEffect(() => {
    onImageWarning?.(imageWarning);
  }, [imageWarning, onImageWarning]);

  // ---- 思考档 ----
  const effortChoices: { value: string; label: string }[] | null = launch
    ? launch.pick.effortLevels.length > 0
      ? [{ value: "", label: "默认" }, ...launch.pick.effortLevels.map((l) => ({ value: l, label: l }))]
      : null
    : next
      ? next.effortLevels.length > 0
        ? [{ value: "", label: "默认" }, ...next.effortLevels.map((l) => ({ value: l, label: l }))]
        : null
      : rt.effortSwitchable
        ? rt.levels.map((l) => ({ value: l, label: l }))
        : null;
  const currentEffort = launch
    ? launch.pick.effort
    : next
      ? next.effort
      : rt.effortIdx >= 0
        ? rt.levels[rt.effortIdx]
        : null;
  const runtimeEffortText =
    rt.effortIdx >= 0
      ? rt.levels[rt.effortIdx]
      : (rt.knownEffort ?? (rt.effortSeenDefault || rt.combo?.thinking ? "默认" : null));

  // ---- 芯片文字（2026-10-22）：前面是品牌色 M（哪家 Agent），后面写模型 · 思考档 ----
  let label: string;
  let title: string;
  let chipEffort: string | null;
  if (launch) {
    // 这家一条连接都没有（快速开聊在本机没有可用连接时也会落到这里）：芯片上直接说，不等点开才看见
    const noConn = launch.pick.profiles.length === 0;
    label = noConn ? `${agentLabel} · 还没有连接` : currentModel || agentLabel;
    chipEffort = noConn ? null : launch.pick.effort || null;
    title = `${agentLabel}${profileId ? ` · ${profileLabel}` : ""}${currentModel ? ` · ${currentModel}` : ""}\n选择这次用哪个 Agent、配置、模型和思考强度（发出第一句前都能改）`;
  } else if (next) {
    label = currentModel || "模型";
    chipEffort = next.effort || null;
    title = `${[label, chipEffort].filter(Boolean).join(" · ")}\n接着聊时用的模型和思考强度（下次启动生效）`;
  } else {
    label = rt.shownModel || "模型";
    chipEffort = runtimeEffortText;
    const shown = [label, chipEffort].filter(Boolean).join(" · ");
    title = !live
      ? "Agent 没在运行"
      : rt.modelState === "pending"
        ? `${shown}\n已发送切换，等 CLI 回显确认`
        : rt.modelState === "unverifiable"
          ? `${shown}\n已发送切换；这家 CLI 不回显当前模型，以终端里显示的为准`
          : `${agentLabel} · ${shown}\n换模型或思考强度`;
  }
  const pendingMark = !launch && !next && rt.modelState !== "confirmed";

  // 行的样子与左下权限菜单同一套（2026-10-18 用户：切换卡片审美再好一点）：选中只靠行尾的勾和字色，
  // 不再整行铺底色；悬停 / 键盘焦点才铺 bg-hover。模型名不用等宽字体——它是名字，不是代码
  const item = (selected: boolean) =>
    `flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-hover focus-visible:bg-hover ${
      selected ? "text-l1" : "text-l2 hover:text-l1"
    }`;
  const twoLine = (selected: boolean) =>
    `flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:bg-hover ${
      selected ? "text-l1" : "text-l2 hover:text-l1"
    }`;
  const mark = (selected: boolean) => (
    <Check
      size={14}
      strokeWidth={2}
      aria-hidden="true"
      className={`shrink-0 ${selected ? "text-l2" : "invisible"}`}
    />
  );
  const section = "px-2 pb-1 pt-1.5 text-xs text-l3";
  const note = "px-2 pb-1.5 pt-0.5 text-xs leading-[18px] text-l4";
  const divider = <div className="mx-1 my-1 h-px shrink-0 bg-hairline" />;
  // 中段滚动区：至少留出两三行，再矮就让整块溢出也比名单缩成一条缝强
  const scrollBody = "relative min-h-[4.5rem] flex-1 overflow-y-auto overscroll-contain";

  function pickModel(m: string) {
    if (launch) launch.onModel(m);
    else if (next) next.onModel(m);
    else rt.pickModel(m);
    setOpen(false);
  }
  function pickEffort(v: string) {
    if (launch) launch.onEffort(v);
    else if (next) next.onEffort(v);
    else rt.setEffortLevel(v);
  }
  function openPicker(cmd: string) {
    runtime?.onTuiCommand(cmd);
    runtime?.onPicker?.();
    setOpen(false);
  }

  // ---- 模型段：开聊前 / 接着聊 = 选启动参数；运行中 = 按这家的切换机制 ----
  // 名单不再自己限高：整个中段是一个滚动区（原先名单、配置各自 max-h 套娃滚动，叠起来照样溢出窗口）
  const modelSection = (() => {
    const list = (
      <ul>
        {models.length === 0 && <li className={note}>用配置默认的模型</li>}
        {models.map((m) => {
          // 出图 / 视频 / 向量等模型选成对话模型，CLI 每一轮都会被网关拒（2026-10-23 gpt-image 实例）：置灰并说原因
          const blocked = nonChatReason(m);
          return (
          <li key={m}>
            <button
              type="button"
              data-selected={m === currentModel}
              disabled={Boolean(blocked) || (relaunchWaiting && rt.modelByRelaunch)}
              className={`${twoLine(m === currentModel)} disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent`}
              title={blocked ? `${m}\n${blocked}` : m}
              onClick={() => pickModel(m)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate leading-[18px]">{m}</span>
                {/* 能力灰字（200K · 思考 · 看图）放在名字下面一行，名字长也不挤 */}
                {blocked ? (
                  <span className="block truncate text-xs leading-[18px] text-l4">{blocked.split("，")[0]}，不能对话</span>
                ) : (
                  caps.labels[m] && <span className="block truncate text-xs leading-[18px] text-l4">{caps.labels[m]}</span>
                )}
              </span>
              {/* 输入框里有图、这个模型确知看不了：当场标出来（不知道的不标） */}
              {hasImages && caps.vision[m] === false && (
                <span className="mt-0.5 shrink-0 text-xs text-caution-text">看不了图</span>
              )}
              <Check
                size={14}
                strokeWidth={2}
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${m === currentModel ? "text-l2" : "invisible"}`}
              />
            </button>
          </li>
          );
        })}
      </ul>
    );
    if (launch) return list;
    if (next) return list;
    if ((rt.modelByRelaunch || runtime?.modelSwitch?.kind === "direct") && models.length > 0) return list;
    if (runtime?.modelSwitch?.kind === "picker") {
      return (
        <button
          type="button"
          className={item(false)}
          onClick={() => openPicker(runtime.modelSwitch!.command)}
          title="这家 CLI 的模型只能在它自己的选择器里选；点了会在下方露出终端，在那里选"
        >
          <span className="min-w-0 truncate">{currentModel || "当前模型"}</span>
          <span className="ml-auto shrink-0 text-xs text-l4">在终端里换…</span>
        </button>
      );
    }
    return (
      <>
        <div className={`${item(true)} cursor-default hover:bg-transparent`}>
          <span className="min-w-0 flex-1 truncate">{currentModel || "当前模型"}</span>
          {mark(true)}
        </div>
        <p className={note}>{agentLabel} 中途不能换模型；新开一段对话时在这里选。</p>
      </>
    );
  })();

  // ---- 思考段 ----
  const effortSection = (() => {
    if (effortChoices) {
      return (
        <EffortSlider
          choices={effortChoices}
          current={currentEffort}
          onCommit={pickEffort}
          disabled={relaunchWaiting && rt.effortByRelaunch}
        />
      );
    }
    if (!launch && !next && rt.effortLive) {
      return (
        <button
          type="button"
          className={item(false)}
          onClick={() => openPicker(rt.effortLive!.command)}
          title="这家 CLI 的思考强度在它自己的选择器里选；点了会在下方露出终端，在那里选"
        >
          <span className="truncate">{rt.knownEffort ? `当前 ${rt.knownEffort}` : "当前档"}</span>
          <span className="ml-auto shrink-0 text-xs text-l4">在终端里换…</span>
        </button>
      );
    }
    if (!launch && !next && rt.combo?.thinking) {
      return (
        <p className={note}>
          当前 {rt.knownEffort ?? "默认"}。{agentLabel} 中途不能换思考强度；新开一段对话时在这里选。
        </p>
      );
    }
    return null;
  })();

  // 底部说明压到一两行，完整原委放悬停提示（原先 Claude 的说明三行，比菜单本身还抢眼）
  const footer: { short: string; full: string } | null = launch
    ? null
    : next
      ? {
          short: "Agent 已经停了。发下一句时按这里的选择接回原来的对话。",
          full: "Agent 已经停了。发下一句时按这里的选择接回原来的对话。",
        }
      : relaunchWaiting
        ? {
            short: "正在生成，等这一轮结束再换。",
            full: `换${rt.modelByRelaunch && rt.effortByRelaunch ? "模型或思考档" : rt.modelByRelaunch ? "模型" : "思考档"}要停下 ${agentLabel} 再接回这段对话，正在生成时换会打断这一轮。`,
          }
        : rt.modelByRelaunch || rt.effortByRelaunch
          ? {
              short: `换${rt.modelByRelaunch && rt.effortByRelaunch ? "模型或思考档" : rt.modelByRelaunch ? "模型" : "思考档"}会停下 ${agentLabel}，用新设置接回这段对话（要几秒），不改它的全局配置。`,
              full: `${agentLabel} 自己的切换命令会把选择写回它的全局配置（以后在终端里直接运行它也会用这个）。Mesa 改成停下它、带着新的启动参数接回原来这段对话，聊过的内容不会丢；接回时会重读整段对话。`,
            }
          : rt.effortPersistsViaCommand
            ? {
                short: `换思考档会写进终端执行；${agentLabel} 会把它存成以后的默认。`,
                full: `这个连接和模型启动时注不进思考档，只能用 ${agentLabel} 自己的命令换；它会把选择写回它的全局配置，以后在终端里直接运行它也会用这一档。`,
              }
            : {
                short: "切换会写进终端执行；要你确认时，对话末尾会出现确认卡。",
                full: "切换会写进终端执行；CLI 要你确认时，对话末尾会出现确认卡。",
              };

  // 上下文用量圆环（docs/design-chat-layer.md §4.4）：上一轮输入占模型窗口的比例，>80% 变 warn；窗口不知道就不画
  const ctxWindow = rt.combo?.context ?? null;
  const ctxUsed = runtime?.contextUsed ?? null;
  const ctxRatio = ctxWindow && ctxUsed ? Math.min(1, ctxUsed / ctxWindow) : null;

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-1">
      {ctxRatio !== null && ctxWindow && ctxUsed && (
        <ContextRing
          ratio={ctxRatio}
          used={ctxUsed}
          window={ctxWindow}
          agentId={agentId}
          breakdown={breakdownRequest(runtime?.status ?? null)}
          onCompact={runtime?.onCompact}
        />
      )}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!launch && !live && !next}
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={`flex h-6 min-w-0 max-w-[20rem] items-center gap-1.5 rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-l3 ${
          open ? "bg-hover text-l1" : ""
        }`}
      >
        {/* 品牌色 M（2026-10-22 用户：圆点换成各家品牌色的 M）：Mesa 标志里那个 M，染成这家 Agent 的品牌色——
            颜色就说明用的是哪家，不再写 Agent 名；M 的形状固定，思考档写在后面的文字里 */}
        {agentId && <AgentMark agentId={agentId} />}
        {/* 模型与档名同一段文字：间距与「Agent · 模型」一致，太长时一起截断 */}
        <span className={`truncate ${pendingMark ? "italic" : ""}`}>
          {label}
          {chipEffort ? ` · ${chipEffort}` : ""}
        </span>
        {pendingMark && rt.modelState === "pending" && <span className="shrink-0 text-l4">待确认</span>}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-label={next ? "接着聊用的模型与思考强度" : "模型与思考强度"}
          // 字号挂在容器上：全站 button / input { font: inherit } 会吞掉按钮自己的 text-*
          // 限高（room）+ 纵向三段：顶部 Agent 行与底部思考 / 说明固定，中间名单区滚动
          className={`absolute right-0 z-30 flex w-[19rem] flex-col overflow-y-auto rounded-xl border border-field ccode-float-surface p-1 text-sm shadow-lg ${
            side === "below" ? "top-full mt-2 origin-top-right" : "bottom-full mb-2 origin-bottom-right"
          }`}
          style={{ maxHeight: room }}
        >
          {view === "who" && launch ? (
            <WhoView
              pick={launch.pick}
              agents={agents}
              onBack={() => setView("main")}
              onAgent={(id) => {
                launch.onAgent(id);
                // 换 Agent：思考档换家后不一定还认，回到「默认」；新那家做不到只讨论 /
                // 没有所选的原生权限档，就回到「按本机设置」，免得启动时才被拒
                if (launch.pick.effort) launch.onEffort("");
                const nextAgent = agents.find((x) => x.id === id);
                if (
                  (launch.pick.permission === "discuss" && !nextAgent?.readonlySupported) ||
                  (launch.pick.permissionMode &&
                    !nextAgent?.permissionModes?.includes(launch.pick.permissionMode))
                ) {
                  launch.onPermission("write_tree", null);
                }
              }}
              onProfile={(id) => {
                launch.onProfile(id);
                setView("main");
              }}
              bodyRef={bodyRef}
              bodyClass={scrollBody}
              item={item}
              mark={mark}
              section={section}
              note={note}
            />
          ) : (
            <>
              {launch && shownCombos.length > 0 && (
                // 最近在这个项目用过的搭配（2026-10-22）：九家 × 多条连接，常换的其实是整套；点一下四样一起换
                <div className="shrink-0">
                  <h4 className={`${section} flex items-center gap-1.5`}>
                    <History size={12} strokeWidth={1.8} aria-hidden="true" />
                    {launch.combosWhere ? `最近在 ${launch.combosWhere} 用过` : "最近用过"}
                  </h4>
                  {shownCombos.map((c) => {
                    const name = AGENTS.find((a) => a.id === c.agentId)?.label ?? c.agentId;
                    const conn = profiles.find((p) => p.id === c.profileId)?.name ?? "";
                    const model = c.model || profiles.find((p) => p.id === c.profileId)?.models[0] || "";
                    return (
                      <button
                        key={`${c.agentId}\t${c.profileId}\t${c.model}\t${c.effort}`}
                        type="button"
                        className={item(false)}
                        title={`${name}${conn ? ` · ${conn}` : ""}${model ? ` · ${model}` : ""}${c.effort ? ` · ${c.effort}` : ""}\n点一下：Agent、连接、模型和思考强度一起换`}
                        onClick={() => {
                          launch.onCombo?.(c);
                          setOpen(false);
                        }}
                      >
                        <AgentMark agentId={c.agentId} />
                        <span className="shrink-0">{name}</span>
                        <span className="ml-auto min-w-0 truncate text-xs text-l4">
                          {[model || null, c.effort || null].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    );
                  })}
                  {divider}
                </div>
              )}
              {launch ? (
                <button
                  type="button"
                  className="flex h-8 w-full shrink-0 items-center gap-1.5 rounded-lg px-2 text-left text-l1 outline-none hover:bg-hover focus-visible:bg-hover"
                  onClick={() => setView("who")}
                  title="换 Agent 或配置"
                >
                  <AgentMark agentId={agentId} />
                  <span className="truncate font-medium">{agentLabel}</span>
                  {profileId && <span className="min-w-0 truncate text-l3">{profileLabel}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-l4">
                    换
                    <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                </button>
              ) : (
                <div
                  className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-l1"
                  title="换 Agent 或配置请新开一段对话"
                >
                  {next && <span className="shrink-0 text-xs text-l4">接着聊用</span>}
                  <span className="truncate font-medium">{agentLabel}</span>
                  {profileLabel && <span className="min-w-0 truncate text-l3">{profileLabel}</span>}
                </div>
              )}
              {divider}
              <h4 className={`${section} shrink-0`}>模型</h4>
              <div ref={bodyRef} className={scrollBody}>
                {modelSection}
                {!launch && !next && rt.modelState === "unverifiable" && (
                  <p className={note}>{agentLabel} 不回显当前模型，切完以终端里显示的为准。</p>
                )}
                {!launch && rt.combo?.mixedModelsNote && <p className={note}>{rt.combo.mixedModelsNote}</p>}
              </div>
              {launch && (
                // 名单里没有的模型照样能用（与启动栏模型输入框同口径：按原样注入）；钉在名单下面，名单再长也不用滚下去找
                <form
                  // 全站 input { font: inherit } 会吞掉 input 自己的 text-*：字号挂在外层
                  className="mx-1 mb-1 mt-1 shrink-0 text-xs"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const m = customModel.trim();
                    if (!m) return;
                    const blocked = nonChatReason(m);
                    if (blocked) {
                      setCustomErr(blocked);
                      return;
                    }
                    launch.onModel(m);
                    setCustomModel("");
                    setOpen(false);
                  }}
                >
                  <input
                    value={customModel}
                    onChange={(e) => {
                      setCustomModel(e.target.value);
                      setCustomErr(null);
                    }}
                    placeholder="其他模型，输入后回车"
                    aria-label="输入其他模型"
                    className="h-7 w-full rounded-lg border border-hairline bg-transparent px-2 text-l2 outline-none placeholder:text-l4 focus:border-field"
                  />
                  {customErr && <p className="mt-1 px-0.5 leading-4 text-caution-text">{customErr}</p>}
                </form>
              )}
              {effortSection && (
                <div className="shrink-0">
                  {divider}
                  {/* 滑块自带「思考强度 … 当前档」一行；其余形态（终端里换 / 只读说明）才要单独标题 */}
                  {!effortChoices && <h4 className={section}>思考强度</h4>}
                  {effortSection}
                </div>
              )}
              {footer && (
                <p
                  className="mx-1 mt-1 flex shrink-0 gap-1.5 border-t border-hairline px-1 pb-0.5 pt-1.5 text-micro leading-4 text-l4"
                  title={footer.full}
                >
                  <Info size={12} strokeWidth={1.8} aria-hidden="true" className="mt-0.5 shrink-0" />
                  <span>{footer.short}</span>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function WhoView({
  pick,
  agents,
  onBack,
  onAgent,
  onProfile,
  bodyRef,
  bodyClass,
  item,
  mark,
  section,
  note,
}: {
  pick: LaunchPickState;
  agents: DetectResult[];
  onBack: () => void;
  onAgent: (id: string) => void;
  onProfile: (id: string) => void;
  bodyRef: RefObject<HTMLDivElement | null>;
  bodyClass: string;
  item: (selected: boolean) => string;
  mark: (selected: boolean) => ReactNode;
  section: string;
  note: string;
}) {
  let lastGroup: string | undefined;
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="flex h-8 w-full shrink-0 items-center gap-1 rounded-lg px-2 text-left text-xs text-l3 outline-none hover:bg-hover hover:text-l1 focus-visible:bg-hover"
      >
        <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="text-xs">模型与思考强度</span>
      </button>
      <div className="mx-1 my-1 h-px shrink-0 bg-hairline" />
      {/* Agent 与配置同在一个滚动区里：原先两段各自 max-h 再叠起来，九家 Agent 一摆就顶出窗口（2026-10-20 用户） */}
      <div ref={bodyRef} className={bodyClass}>
        <h4 className={section}>Agent</h4>
        {/* 九家排成两列：名字都短，单列一家一行太占高度 */}
        <div className="grid grid-cols-2 gap-x-0.5">
          {AGENTS.map((a) => {
            const installed = agents.find((x) => x.id === a.id)?.binaryPath != null;
            const selected = a.id === pick.agentId;
            return (
              <button
                key={a.id}
                type="button"
                data-selected={selected}
                className={`${item(selected)} ${selected ? "bg-seg-sel hover:bg-seg-sel" : ""}`}
                title={installed ? a.label : `${a.label}（本机还没装）`}
                onClick={() => onAgent(a.id)}
              >
                <span className={`min-w-0 flex-1 truncate ${installed ? "" : "text-l4"}`}>{a.label}</span>
                {!installed && <span className="shrink-0 text-micro text-l4">未安装</span>}
              </button>
            );
          })}
        </div>
        <div className="mx-1 my-1 h-px bg-hairline" />
        <h4 className={section}>配置</h4>
        <ul>
          {pick.profiles.length === 0 && (
            <li className={note}>这个 Agent 还没有配置，去「连接」页添加</li>
          )}
          {pick.profiles.map((p) => {
            const header = p.group && p.group !== lastGroup ? p.group : null;
            lastGroup = p.group;
            return (
              <li key={p.value}>
                {header && <div className="px-2 pb-0.5 pt-1.5 text-micro text-l4">{header}</div>}
                <button
                  type="button"
                  disabled={p.disabled}
                  data-selected={p.value === pick.profileId}
                  className={`${item(p.value === pick.profileId)} disabled:opacity-40`}
                  onClick={() => onProfile(p.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  {mark(p.value === pick.profileId)}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/** Agent 标记：Mesa 标志里的 M（与图标源同一条路径），染成这家的品牌色；悬停写 Agent 名 */
function AgentMark({ agentId }: { agentId: string }) {
  const name = AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
  return (
    <svg
      viewBox="232 284 560 456"
      className="h-[0.8em] w-auto shrink-0"
      role="img"
      aria-label={name}
      style={{ color: agentBrand(agentId) }}
    >
      <title>{name}</title>
      <path
        d="M232 740 V284 H356 L512 512 L668 284 H792 V740 H672 V474 L548 652 H476 L352 474 V740 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 菜单里每个模型后面那行灰字（200K · 思考 · 看图）与能不能看图：能力库按网关逐字段查 */
function useModelCaps(
  models: string[],
  gatewayId: string | null,
): { labels: Record<string, string>; vision: Record<string, boolean | null> } {
  const [caps, setCaps] = useState<{ labels: Record<string, string>; vision: Record<string, boolean | null> }>({
    labels: {},
    vision: {},
  });
  const key = useMemo(() => models.join("\n"), [models]);
  useEffect(() => {
    if (!key) return;
    let stale = false;
    invoke<ModelCapabilityDto[]>("model_capabilities", { models: key.split("\n"), gatewayId })
      .then((list) => {
        if (stale) return;
        const labels: Record<string, string> = {};
        const vision: Record<string, boolean | null> = {};
        for (const c of list) {
          labels[c.model] = modelCapsLabel(c);
          vision[c.model] = c.vision;
        }
        setCaps({ labels, vision });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [key, gatewayId]);
  return caps;
}

/**
 * 思考强度滑块（2026-10-17 用户：档位切换做成滑块；2026-10-22 第二版设计稿：融进 Mesa 图标）。滑块就是图标里的「M▁」——
 * 琥珀光标块沿一条基线滑，档位刻度是基线上的短竖线（像尺子）；右上的小 M 中间那道 V 随档位加深（EffortMark），
 * 下面一句白话说这一档意味着什么（effort-depth.ts），档名照 CLI 原名。分段按钮在档多的家放不下（Grok 连「默认」8 档）。
 * 隐形原生 range 管拖动、键盘、读屏。拖动中只改预览，松手（或键盘抬起）才提交——运行中提交 = 往终端写一次命令，
 * 不能拖一路写一路。current 为 null = 不知道当前档（运行中 CLI 没报），光标块不出现。
 */
function EffortSlider({
  choices,
  current,
  onCommit,
  disabled = false,
}: {
  choices: { value: string; label: string }[];
  current: string | null;
  onCommit: (value: string) => void;
  disabled?: boolean;
}) {
  const knownIdx = current === null ? -1 : choices.findIndex((c) => c.value === current);
  const [draft, setDraft] = useState<number | null>(null);
  useEffect(() => setDraft(null), [current]);
  const idx = draft ?? knownIdx;
  const last = choices.length - 1;
  const pct = (i: number) => (last > 0 ? (i / last) * 100 : 0);
  const label = idx >= 0 ? choices[idx].label : "未知";
  const levels = choices.map((c) => c.value).filter(Boolean);
  const depth = idx >= 0 ? effortDepth(choices[idx].value, levels) : null;
  function commit() {
    if (draft === null || draft === knownIdx) {
      setDraft(null);
      return;
    }
    onCommit(choices[draft].value);
    // 松手后回到真值：运行中要等 CLI 回显（中途换档会先弹确认，选 No 档位不变）；开聊前 current 会立刻跟上
    setDraft(null);
  }
  // 档不多（≤6，含「默认」）时每个刻度下都写档名，一眼看出在哪一格、点名字也能选；Grok 那种八档只写两端
  const labelAll = choices.length <= 6;
  const dragging = draft !== null;
  // 拖动时光标块跟手；点刻度 / 点档名 / 键盘跳格时滑过去（120ms，动效口径 200ms 内）
  const glide = dragging ? "" : "transition-[left,width] duration-[120ms] ease-[var(--ccode-motion-ease)]";
  return (
    <div className={`group/effort px-2 pb-2 pt-1.5 ${disabled ? "opacity-50" : ""}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs text-l3">思考强度</span>
        <span className={`flex items-center gap-1.5 text-xs font-medium ${idx >= 0 ? "text-l1" : "text-l4"}`}>
          <EffortMark depth={depth} className="h-3 w-auto" />
          {label}
        </span>
      </div>
      {/* 左右各缩进半个光标块，两端不贴边；原生 range 向两边各伸出半块，它的停靠点才与画出来的刻度对齐 */}
      <div className="relative mx-2.5 h-5">
        <span className="absolute bottom-1 left-0 h-0.5 w-full rounded-full bg-field" />
        {idx >= 0 && (
          <span
            className={`absolute bottom-1 left-0 h-0.5 rounded-full bg-l3 ${glide}`}
            style={{ width: `${pct(idx)}%` }}
          />
        )}
        {/* 刻度：基线上的短竖线（光标块盖住的那一格不画） */}
        {choices.map((c, i) =>
          i === idx ? null : (
            <span
              key={c.value || "default"}
              aria-hidden="true"
              className={`absolute bottom-1 h-1.5 w-px -translate-x-1/2 ${i < idx ? "bg-l3" : "bg-l4"}`}
              style={{ left: `${pct(i)}%` }}
            />
          ),
        )}
        {idx >= 0 && (
          <span
            aria-hidden="true"
            // 光标块：M▁ 里那一道（琥珀 + 余辉，App.css .ccode-effort-knob），坐在基线上
            className={`ccode-effort-knob pointer-events-none absolute bottom-1 h-2 w-4 -translate-x-1/2 rounded-xs ${glide} ${
              disabled ? "" : "group-hover/effort:scale-110"
            } group-has-[input:focus-visible]/effort:outline group-has-[input:focus-visible]/effort:outline-1 group-has-[input:focus-visible]/effort:outline-offset-2 group-has-[input:focus-visible]/effort:outline-l3`}
            style={{ left: `${pct(idx)}%` }}
          />
        )}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.max(0, idx)}
          aria-label="思考强度"
          aria-valuetext={label}
          disabled={disabled}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") commit();
          }}
          className="absolute inset-y-0 -right-2.5 -left-2.5 m-0 h-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default [&::-moz-range-thumb]:size-4 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none"
        />
      </div>
      {labelAll ? (
        <div className="relative mx-2.5 mt-1 h-4 text-micro">
          {choices.map((c, i) => (
            // 读屏走上面的 range；这里是给鼠标的快捷点选。外层 px-2 + mx-2.5 给两端居中的档名留了位置
            <span
              key={c.value || "default"}
              aria-hidden="true"
              onClick={() => (disabled || i === knownIdx ? undefined : onCommit(c.value))}
              className={`absolute top-0 -translate-x-1/2 cursor-pointer whitespace-nowrap leading-4 ${
                i === idx ? "font-medium text-l1" : "text-l4 hover:text-l2"
              }`}
              style={{ left: `${pct(i)}%` }}
            >
              {c.label}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-1 flex justify-between text-micro leading-4 text-l4">
          <span>{choices[0]?.label}</span>
          <span>{choices[last]?.label}</span>
        </div>
      )}
      {idx >= 0 && <p className="mt-1.5 text-xs leading-[18px] text-l3">{effortGloss(depth)}</p>}
    </div>
  );
}
