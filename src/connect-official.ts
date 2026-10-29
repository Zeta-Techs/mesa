/**
 * 上手向导用的官方账号接入：探测（只读 auth 文件）、一键加「官方账号」连接、没登录时开终端登录标签。
 * 与连接页组头「＋ 官方账号」「官方登录」同源（名字后端固定、不要网关和密钥）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { toast } from "./toast";
import { AGENTS, type OfficialAccountStatusDto } from "./types";
import type { OnboardingOfficialProbe } from "./onboarding";

const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** 已装 Agent 的官方账号状态：已登录 → ready，没登录 → login，不支持（或读失败）→ none */
export async function probeOfficial(installed: readonly string[]): Promise<OnboardingOfficialProbe> {
  const pairs = await Promise.all(
    installed.map(async (agentId) => {
      try {
        const st = await invoke<OfficialAccountStatusDto>("official_account_status", { agentId });
        return [agentId, !st.supported ? "none" : st.connected ? "ready" : "login"] as const;
      } catch {
        return [agentId, "none"] as const;
      }
    }),
  );
  return Object.fromEntries(pairs);
}

/** 加一条「官方账号」连接；失败弹错并返回 false */
export async function connectOfficialAccount(agent: string): Promise<boolean> {
  try {
    await useAppStore.getState().saveProfile(null, {
      agent,
      name: "官方账号",
      accountType: "official",
      noAuth: false,
      protocol: null,
      baseUrl: null,
      models: [],
      extraEnv: {},
      apiKey: null,
    });
    return true;
  } catch (e) {
    toast(`接入失败：${String(e)}`, "error");
    return false;
  }
}

/** 官方账号还没登录：开内嵌终端登录标签（同连接页「官方登录」），跳到终端页；调用方负责收起向导 */
export async function startOfficialLogin(agent: string): Promise<void> {
  try {
    const st = await invoke<OfficialAccountStatusDto>("official_account_status", { agentId: agent });
    if (!st.loginCommand) {
      toast(`${labelOf(agent)} 暂不支持在 Mesa 里登录，请在终端里自行登录`, "warning");
      return;
    }
    const s = useAppStore.getState();
    s.setPendingTerminal({
      cwd: "~",
      extraEnv: { ...(st.loginEnv ?? {}) },
      title: `登录 ${labelOf(agent)}`,
      prefillCommand: st.loginCommand,
      shellOnly: true,
      reuseKey: `login:${agent}`,
    });
    s.setPage("terminal");
    toast(`登录完成后点侧栏「上手引导」回来，就能一键接入 ${labelOf(agent)} 官方账号`, "info");
  } catch (e) {
    toast(`无法开始登录：${String(e)}`, "error");
  }
}
