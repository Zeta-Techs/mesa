/**
 * 已核对到的 CLI 版本（构建时从 CLI 金丝雀基线读进来，单一出处：`scripts/cli-canary/baseline/<平台>/<agent>.json`）。
 * 只取 version 字段（Vite 对 JSON 的具名导入，其余字段不进包）。纯逻辑在 chat-fidelity.ts；
 * 这个文件用了 import.meta.glob，测试不导入它。
 */
import { verifiedVersion, versionTrust, type VerifiedTable } from "./chat-fidelity";
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

/** 这一家的 CLI 比 Mesa 核对过的新（读屏可能已对不上）：替人自动按的步骤先停、确认卡上提醒一句 */
export function useCliNewer(agentId: string | null | undefined): boolean {
  const installed = useAppStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.version ?? null : null));
  if (!agentId) return false;
  return versionTrust(installed, verifiedVersion(VERIFIED_VERSIONS, CANARY_PLATFORM, agentId)) === "newer";
}
