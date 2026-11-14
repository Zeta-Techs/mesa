/**
 * 运行中换模型 / 思考档走哪条路（纯逻辑，tests/switch-strategy.test.ts）。
 *
 * 2026-10-18 用户：在 Mesa 里切 Claude 的模型或思考档，会改掉终端里 `claude` 的默认值。逐家实测
 * （scripts/e2e-model-routing/chat-capture.py，临时 HOME 里比对切换前后的配置文件）：下面这几家用它自己的
 * 命令中途切换时，都会把选择写回它的全局配置——Mesa 替用户敲的命令等于替用户改了 CLI 配置，违背「CLI 配置目录
 * 只读」。这几家改成「停下 AI，带着新的启动参数接回原来这段对话」（与换权限同一条路），不写全局配置；
 * 代价是要等几秒、接回时重读整段对话（Claude 中途切换本来就要重读）。
 *   Claude Code 2.1.292：/model 写 settings.json 的 model；/effort 写 settings.json 里这个模型的 effortLevel
 *   Codex 0.163：/model 选择器写 config.toml 的 model 与 model_reasoning_effort（而且列的是官方模型，不是连接里的）
 *   Grok 1.0.62：/model 写 config.toml 的 [models] default（/effort 不写）
 *   Qwen 0.25：/effort 写 settings.json 的 reasoningEffort
 *   Kimi 2.2：/effort on|off 写 config.toml 的 thinking enabled
 * 没写回的：Gemini 0.64 /model set（只管这一段），Grok /effort——这两样照旧中途切，快。
 * 启动时注不进去的（思考档：combo_surface.injectEffortAllowed 为假）只能退回命令，菜单底部写明会存成默认。
 *
 * 2026-11-04：Codex 0.164 起 `/model [模型] --reasoning <档>` 带参数时只改这一段、不写 config.toml（本机 0.166 实测：
 * 屏上「Model changed to … for this session only」，config.toml 不动；Mesa 的 --remote 经 app-server 起时请求也照样换）。
 * 这个版本起 Codex 换模型 / 思考档改回中途切，不用停下重开。
 */
import { parseVersion } from "./chat-fidelity.ts";

const CODEX_SESSION_SWITCH_MIN: [number, number, number] = [0, 164, 0];
/** Codex 0.166 起生成中也收 /model --reasoning（0.166.0-alpha.6、0.167.1 实测，回显「for this session only」，下一轮生效） */
const CODEX_MID_TURN_MIN: [number, number, number] = [0, 166, 0];
/** Kimi 2.5.3：/effort 选择器里 Alt+S 只改本段（带参数的 /effort 会存成默认，不用）；生成中也能切，下一轮生效 */
const KIMI_SESSION_EFFORT_MIN: [number, number, number] = [2, 5, 3];

function atLeast(version: string | null | undefined, min: [number, number, number]): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** 这一家这个版本能在会话里直接切、又不写全局配置的命令（{model} / {level} 占位）；没有返回 null */
export function inSessionSwitchCommand(
  agentId: string,
  kind: "model" | "effort",
  version: string | null | undefined,
): string | null {
  if (agentId === "codex" && atLeast(version, CODEX_SESSION_SWITCH_MIN)) {
    return kind === "model" ? "/model {model}" : "/model --reasoning {level}";
  }
  // Kimi 的 /effort <档> 只是 Mesa 内部的写法：TerminalView runTuiCommand 认出它，改成「唤选择器 → 挪到这一档 → 核对 → Alt+S」，
  // 不把带参数的命令写进终端（那样会存成默认，matrix「会话内换权限 / 思考档」）
  if (agentId === "kimi" && kind === "effort" && atLeast(version, KIMI_SESSION_EFFORT_MIN)) return KIMI_EFFORT_PICK;
  return null;
}

/** Kimi 会话内切思考档的内部命令前缀（runTuiCommand 拦下改走选择器，见 kimiEffortPickLevel） */
export const KIMI_EFFORT_PICK = "/effort {level}";

/** 这条命令是不是要改走 Kimi 思考档选择器：是就返回要切到的档 */
export function kimiEffortPickLevel(agentId: string, version: string | null | undefined, cmd: string): string | null {
  if (agentId !== "kimi" || !atLeast(version, KIMI_SESSION_EFFORT_MIN)) return null;
  const m = /^\/effort\s+(\S+)\s*$/.exec(cmd.trim());
  return m ? m[1] : null;
}

/** 会话内切换在生成中也收、下一轮生效（不必等这一轮结束） */
export function inSessionSwitchMidTurn(agentId: string, version: string | null | undefined): boolean {
  if (agentId === "codex") return atLeast(version, CODEX_MID_TURN_MIN);
  if (agentId === "kimi") return atLeast(version, KIMI_SESSION_EFFORT_MIN);
  return false;
}

export const SWITCH_PERSISTS: Record<string, { model?: boolean; effort?: boolean }> = {
  "claude-code": { model: true, effort: true },
  codex: { model: true, effort: true },
  grok: { model: true },
  qwen: { effort: true },
  kimi: { effort: true },
  // Antigravity CLI 1.5.8 沙箱实测：/model 会把 mesa/<模型> 写进 ~/.gemini/antigravity-cli/settings.json，
  // 且思考档只有启动参数 --effort（无 /effort 斜杠命令），统一走重开接回
  agy: { model: true, effort: true },
};

export function switchPersists(agentId: string, kind: "model" | "effort", version?: string | null): boolean {
  if (inSessionSwitchCommand(agentId, kind, version)) return false;
  return Boolean(SWITCH_PERSISTS[agentId]?.[kind]);
}

/** 这次换 kind 要不要走「重开接回」：会写回全局配置、且启动时能把新值注进去 */
export function switchByRelaunch(
  agentId: string,
  kind: "model" | "effort",
  injectableAtLaunch: boolean,
  version?: string | null,
): boolean {
  return switchPersists(agentId, kind, version) && injectableAtLaunch;
}

type InlineTier = "ask" | "auto" | "full";

/**
 * 会话里直接换权限、不用重开（2026-11-11 实测，matrix「会话内换权限 / 思考档」节；docs/design-chat-inline-switch.md 2.A）。
 * 只登记「会话里能换、又不写全局配置、且能精确落到某一档」的家：
 *   Kimi 2.5.3：/permission 选择器（Always Ask / Ask When Needed / Never Ask），生成中也能换、这一轮就生效
 *   Codex 0.166+：/permissions 选择器（另有 Read Only 一项），选完全访问还要再答一层「Enable full access?」；生成中能发、下一轮生效
 *   Qwen 0.26.7：/approval-mode <档> 带参数直切；生成中发的排队，这一轮结束后执行
 * Claude、Gemini、Grok、CodeBuddy 只能用快捷键轮着换（CodeBuddy 从 default 按一下就是 bypass），Mesa 不替人轮，维持重开接回。
 * 选择器的原文与顺序照屏上抄：替人选之前逐项核对（tui-menu pickerTargetIndex），对不上就不按、交给人点
 */
export interface InSessionPermission {
  command: string;
  /** 带参数直切的家：每档跟在命令后面的参数 */
  args?: Partial<Record<InlineTier, string>>;
  /** 选择器的家：全部选项原文（按屏上顺序）与每档对应哪一项；完全访问还要再答一层的，那一层的原文与要选的项 */
  picker?: {
    options: string[];
    tiers: Partial<Record<InlineTier, string>>;
    fullConfirm?: { options: string[]; pick: string };
  };
  /** 回复中换：now = 这一轮就生效；next = 下一轮生效；queued = CLI 把命令排到这一轮结束后执行 */
  midTurn: "now" | "next" | "queued";
}

const KIMI_INLINE_PERMISSION_MIN: [number, number, number] = [2, 5, 3];
const CODEX_INLINE_PERMISSION_MIN: [number, number, number] = [0, 166, 0];
const QWEN_INLINE_PERMISSION_MIN: [number, number, number] = [0, 26, 7];

export function inSessionPermissionSwitch(
  agentId: string,
  version: string | null | undefined,
): InSessionPermission | null {
  if (agentId === "kimi" && atLeast(version, KIMI_INLINE_PERMISSION_MIN)) {
    return {
      command: "/permission",
      picker: {
        options: ["Always Ask", "Ask When Needed", "Never Ask"],
        tiers: { ask: "Always Ask", auto: "Ask When Needed", full: "Never Ask" },
      },
      midTurn: "now",
    };
  }
  if (agentId === "codex" && atLeast(version, CODEX_INLINE_PERMISSION_MIN)) {
    return {
      command: "/permissions",
      picker: {
        options: ["Ask for approval", "Approve for me", "Full Access", "Read Only"],
        tiers: { ask: "Ask for approval", auto: "Approve for me", full: "Full Access" },
        fullConfirm: { options: ["Yes, continue anyway", "Cancel"], pick: "Yes, continue anyway" },
      },
      midTurn: "next",
    };
  }
  if (agentId === "qwen" && atLeast(version, QWEN_INLINE_PERMISSION_MIN)) {
    return { command: "/approval-mode", args: { ask: "default", auto: "auto", full: "yolo" }, midTurn: "queued" };
  }
  return null;
}

/** 在对话里只能用快捷键轮着换档的家（实测）：换权限要重开接回，菜单里写一句原因 */
export const PERMISSION_CYCLE_ONLY = new Set(["claude-code", "gemini", "grok", "codebuddy", "agy"]);
