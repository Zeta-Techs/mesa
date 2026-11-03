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
  return null;
}

export const SWITCH_PERSISTS: Record<string, { model?: boolean; effort?: boolean }> = {
  "claude-code": { model: true, effort: true },
  codex: { model: true, effort: true },
  grok: { model: true },
  qwen: { effort: true },
  kimi: { effort: true },
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
