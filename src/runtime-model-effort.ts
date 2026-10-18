import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KIMI_CSI_U_ENTER } from "./terminal-input";
import { EFFORT_SEEN_DEFAULT, currentEffort, modelReadbackSupported } from "./reasoning-effort";
import type { ComboSurfaceDto, DetectResult } from "./types";
import type { TabStatus } from "./pages/TerminalPage";
import { switchByRelaunch, switchPersists } from "./switch-strategy";

/** 切模型命令发出后的待确认记录：baseline = 发命令时屏上读到的模型，屏上读回值一变就以读回为准 */
const modelOverrides = new Map<string, { model: string; baseline: string | null; at: number }>();
/** 能读回的 CLI 等这么久还没回显（多半在确认菜单里选了「No」）：放弃待确认，回到读回值 */
const PENDING_MS = 20_000;
const overrideListeners = new Set<() => void>();
function subscribeOverrides(fn: () => void) {
  overrideListeners.add(fn);
  return () => {
    overrideListeners.delete(fn);
  };
}

/**
 * 运行中切模型 / 思考档的共用逻辑（原在 TerminalStatusBar 里，2026-10-17 抽出）：
 * 终端底栏与聊天输入框右侧的「模型 · 思考」芯片同用一份——显示什么、能不能切、怎么写命令，
 * 两处不得各算各的（同一事实只说一次）。
 *
 * send：写一条 TUI 命令。缺省直接 pty_write；聊天层传入标签动作 runTuiCommand，
 * 写完会盯几秒屏幕，CLI 弹出确认菜单时聊天层给按钮（tui-menu.ts）。
 */
export function useRuntimeModelEffort(opts: {
  status: TabStatus | null;
  profileId: string | null;
  /** 启动时注入的模型；求交不跟 CLI 内 /model */
  launchModel: string | null;
  modelSwitch: DetectResult["modelSwitch"];
  effort: DetectResult["effort"];
  submitCsiU: boolean;
  send?: (cmd: string) => void;
  /** 停下 Agent、带着新模型 / 思考档接回原对话（标签动作 relaunchWith）。会写回全局配置的切换走这条（switch-strategy.ts） */
  relaunch?: (patch: { model?: string; effort?: string | null }) => void;
}) {
  const { status, profileId, launchModel, modelSwitch, effort, submitCsiU, send, relaunch } = opts;
  const agentId = status?.agentId ?? "";
  /** 换模型走重开接回（Mesa 自己列连接里的模型，不唤 CLI 的选择器、不写 CLI 的全局配置） */
  const modelByRelaunch = Boolean(relaunch) && switchByRelaunch(agentId, "model", true);
  /** 这一轮还在生成：重开会打断它，等这一轮结束再换 */
  const relaunchBlocked = status?.attention === "working";

  // 模型显示名的真值：屏上读回（status.modelSeen：/model 回显、开场横幅）> 刚发出的切换（待确认）> 启动模型。
  // 待确认记录按进程（ptyId）存在模块级表里：底栏与输入框芯片各挂一个实例，在一处切了另一处也得跟着变。
  // 原先切完就直接显示新名字，CLI 拒绝或改写时芯片照样写新名字（2026-10-17 用户）
  const ptyId = status?.ptyId ?? null;
  const pending = useSyncExternalStore(subscribeOverrides, () =>
    ptyId ? (modelOverrides.get(ptyId) ?? null) : null,
  );
  const seenModel = status?.modelSeen ?? null;
  const readback = modelReadbackSupported(status?.agentId ?? "");
  const [, setTick] = useState(0);
  const expired = pending !== null && readback && Date.now() - pending.at > PENDING_MS;
  useEffect(() => {
    if (!pending || !readback) return;
    const left = pending.at + PENDING_MS - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => window.clearTimeout(t);
  }, [pending, readback]);
  const superseded = pending !== null && seenModel !== null && seenModel !== pending.baseline;
  const pendingModel =
    pending && !superseded && !expired && pending.model !== seenModel ? pending.model : null;
  const shownModel = pendingModel ?? seenModel ?? status?.model ?? "";
  /** confirmed = 屏上读到或没切过；pending = 已发送、等回显；unverifiable = 这家 CLI 读不回，以终端为准 */
  const modelState: "confirmed" | "pending" | "unverifiable" = !pendingModel
    ? "confirmed"
    : readback
      ? "pending"
      : "unverifiable";

  function writeCmd(cmd: string) {
    if (send) {
      send(cmd);
      return;
    }
    if (status?.ptyId) {
      // Enter 形式按各家 TUI 键盘协议分派：kimi 开了 kitty 协议只认 CSI-u（\x1b[13u），
      // 其余认 \r（与 injectToActiveAgent 的「send 补 \r」同口径）
      const enter = submitCsiU ? KIMI_CSI_U_ENTER : "\r";
      invoke("pty_write", { ptyId: status.ptyId, data: `${cmd}${enter}` }).catch(() => {});
    }
  }

  function pickModel(m: string) {
    if (modelByRelaunch) {
      if (relaunchBlocked || m === (status?.model ?? "")) return;
      relaunch?.({ model: m });
      return;
    }
    if (!modelSwitch || modelSwitch.kind !== "direct") return;
    // kimi 的 /model 参数是 config.toml 的 [models.*] 别名（非法字符清洗为 _，
    // 与 global_config.rs 的 kimi_model_alias 同规则）；别家直接吃模型 id
    const arg = status?.agentId === "kimi" ? m.replace(/[^A-Za-z0-9_-]/g, "_") : m;
    writeCmd(modelSwitch.command.replace("{model}", arg));
    if (ptyId) {
      modelOverrides.set(ptyId, { model: m, baseline: seenModel, at: Date.now() });
      overrideListeners.forEach((fn) => fn());
    }
  }

  const [combo, setCombo] = useState<ComboSurfaceDto | null>(null);
  const [comboReady, setComboReady] = useState(false);
  useEffect(() => {
    if (!profileId || !launchModel) {
      setCombo(null);
      setComboReady(true);
      return;
    }
    let cancelled = false;
    setComboReady(false);
    invoke<ComboSurfaceDto>("combo_surface", { profileId, model: launchModel })
      .then((c) => {
        if (!cancelled) {
          setCombo(c);
          setComboReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCombo(null);
          setComboReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, launchModel]);
  // 未确认不显示：combo 未加载或求交明确不允许时藏 /effort
  const effortLive = comboReady && combo?.showNativeEffort === true ? effort : null;
  /** 换思考档走重开接回：会写回全局配置、且这个组合启动时能注入思考档 */
  const effortByRelaunch =
    Boolean(relaunch) && switchByRelaunch(agentId, "effort", combo?.injectEffortAllowed === true);
  /** 中途切会写回全局配置、但启动时又注不进去：只能用命令，菜单底部要写明会存成默认 */
  const effortPersistsViaCommand = switchPersists(agentId, "effort") && !effortByRelaunch;

  const nativeLevels =
    combo?.effortLevels && combo.effortLevels.length > 0
      ? combo.effortLevels
      : (effortLive?.levels ?? effort?.levels ?? []);
  // 没有原生档表、只有启动注入通道的（Codex）给通用三档，与开聊前选择器同口径
  const levels =
    nativeLevels.length > 0 ? nativeLevels : effortByRelaunch ? ["low", "medium", "high"] : [];
  /** 运行中能不能在 Mesa 里换思考档（命令或重开接回） */
  const effortSwitchable = (Boolean(effortLive) || effortByRelaunch) && levels.length > 1;
  // 当前档的真值：CLI 画在屏上的 > 本次开工覆盖 > 绑定开场档；都没有 = 不知道。
  // 原先初值硬写「第 2 格」，CLI 实际跑 xhigh 时状态栏显示 low（2026-10-17 用户报）
  const knownEffort = currentEffort({
    seen: status?.effortSeen,
    override: status?.effortOverride,
    launch: combo?.launchEffort,
  });
  const knownIdx = knownEffort ? levels.indexOf(knownEffort) : -1;
  const effortSeenDefault = status?.effortSeen === EFFORT_SEEN_DEFAULT;
  // 用户拖动 / 点选后、CLI 回显前的本地选择；真值一变（回显到达 / 换标签）就让位
  const [draftIdx, setDraftIdx] = useState<number | null>(null);
  useEffect(() => {
    setDraftIdx(null);
  }, [knownEffort, status?.ptyId]);
  // -1 = 不知道当前档（或当前档不在可切换表里）：不点亮任何一格
  const effortIdx = draftIdx !== null && draftIdx < levels.length ? draftIdx : knownIdx;
  const effortLabel = effortIdx >= 0 ? levels[effortIdx] : (knownEffort ?? "默认");

  function applyEffort(level: string) {
    if (!levels.includes(level)) return;
    if (effortByRelaunch) {
      if (relaunchBlocked || level === knownEffort) return;
      relaunch?.({ effort: level });
      return;
    }
    if (effortLive) writeCmd(effortLive.command.replace("{level}", level));
  }
  function commitEffort() {
    if (effortIdx >= 0 && levels[effortIdx]) applyEffort(levels[effortIdx]);
  }
  /** 直接切到某一档（输入框芯片点选用）：只写命令 / 重开，不先点亮——Claude Code 中途换档会先弹
   *  「Change effort level?」确认，用户选「No」时档位不变；以屏上回显（effortSeen）为准 */
  function setEffortLevel(level: string) {
    applyEffort(level);
  }

  return {
    shownModel,
    modelState,
    pickModel,
    writeCmd,
    combo,
    effortLive,
    levels,
    knownEffort,
    effortSeenDefault,
    effortIdx,
    setDraftIdx,
    effortLabel,
    commitEffort,
    setEffortLevel,
    modelByRelaunch,
    effortByRelaunch,
    effortSwitchable,
    effortPersistsViaCommand,
    relaunchBlocked,
  };
}
