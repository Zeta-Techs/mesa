/**
 * 已核对到的 CLI 版本（构建时从 CLI 金丝雀基线读进来，单一出处：`scripts/cli-canary/baseline/<平台>/<agent>.json`）。
 * 只取 version 字段（Vite 对 JSON 的具名导入，其余字段不进包）。纯逻辑在 chat-fidelity.ts；
 * 这个文件用了 import.meta.glob，测试不导入它。
 * 2026-11-04 起另向后端要「联网前移」的版本（`cli_verified.rs`：main 上指纹没变、只是版本往前走的基线），两者取较新的。
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { baselineKey, newerVersion, verifiedVersion, versionTrust, type VerifiedTable } from "./chat-fidelity";
import { IS_MAC, IS_WINDOWS } from "./hotkeys";
import { useAppStore } from "./store";

// Vite 在构建时把这次调用换成对象字面量；测试里用 esbuild 打包组件时没有 import.meta.glob，当空表（全按「没核对过」）
let files: Record<string, string> = {};
try {
  files = import.meta.glob<string>("../scripts/cli-canary/baseline/*/*.json", {
    eager: true,
    import: "version",
  });
} catch {
  files = {};
}

export const VERIFIED_VERSIONS: VerifiedTable = (() => {
  const table: VerifiedTable = {};
  for (const [path, version] of Object.entries(files)) {
    const m = /baseline\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!m || typeof version !== "string") continue;
    (table[m[1]] ??= {})[m[2]] = version;
  }
  return table;
})();

/** 基线按 Node 的 process.platform 命名（darwin / win32 / linux） */
export const CANARY_PLATFORM = IS_WINDOWS ? "win32" : IS_MAC ? "darwin" : "linux";

/** 后端联网前移的核对版本（agent → 版本）；Mesa 常驻后台，半天再问一次（后端自己有半天缓存） */
let advanced: Record<string, string> = {};
const listeners = new Set<() => void>();
let loading = false;
const REFRESH_MS = 12 * 3600 * 1000;

function loadAdvanced() {
  if (loading) return;
  loading = true;
  const pull = () =>
    invoke<Record<string, string>>("cli_verified_advanced")
      .then((table) => {
        advanced = table ?? {};
        listeners.forEach((fn) => fn());
      })
      .catch(() => {});
  void pull();
  window.setInterval(() => void pull(), REFRESH_MS);
}

function subscribe(fn: () => void) {
  loadAdvanced();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 这一家眼下认的核对版本：随包的与联网前移的取较新（基线名按装的版本取，见 baselineKey） */
export function currentVerifiedVersion(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const installed = useAppStore.getState().agents.find((a) => a.id === agentId)?.version ?? null;
  const key = baselineKey(agentId, installed);
  return newerVersion(verifiedVersion(VERIFIED_VERSIONS, CANARY_PLATFORM, key), advanced[key] ?? null);
}

export function useVerifiedVersion(agentId: string | null | undefined): string | null {
  const installed = useAppStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.version ?? null : null));
  const key = agentId ? baselineKey(agentId, installed) : null;
  const remote = useSyncExternalStore(subscribe, () => (key ? advanced[key] ?? null : null));
  if (!key) return null;
  return newerVersion(verifiedVersion(VERIFIED_VERSIONS, CANARY_PLATFORM, key), remote);
}

/** 这一家的 CLI 比 Mesa 核对过的新（读屏可能已对不上）：替人自动按的步骤先停、确认卡上提醒一句 */
export function useCliNewer(agentId: string | null | undefined): boolean {
  const installed = useAppStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.version ?? null : null));
  const verified = useVerifiedVersion(agentId);
  if (!agentId) return false;
  return versionTrust(installed, verified) === "newer";
}
