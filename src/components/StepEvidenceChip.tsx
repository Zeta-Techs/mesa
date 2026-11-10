import { useEffect, useState } from "react";
import { researchRelativePath } from "../research-report";
import { readResearchFile } from "../research-report-load";
import { stepEvidenceLabel, stepEvidenceSummaryOf } from "../step-evidence";
import type { ProjectStepDto, WorkspaceDto } from "../types";

const lastLabels = new Map<string, string | null>();

/** 当前步骤卡上的一行：报告自述的质量状态，以及未决标记数量。 */
export default function StepEvidenceChip({
  projectPath,
  step,
  workspaces,
  refreshToken,
}: {
  projectPath: string;
  step: ProjectStepDto;
  workspaces: WorkspaceDto[];
  refreshToken: number;
}) {
  const active = workspaces.find(
    (workspace) => workspace.name === step.workspaceName && workspace.status === "active",
  );
  const root = active?.worktreePath || projectPath;
  const paths = (step.expectedArtifacts ?? [])
    .map((path) => researchRelativePath(path))
    .filter((path): path is string => !!path && path.endsWith(".md") && !path.includes("*"))
    .slice(0, 8);
  const identity = JSON.stringify([root, paths]);
  const key = JSON.stringify([identity, refreshToken]);
  // 读到的状态连同「是哪一步的」一起记：切步骤时这个组件不重新挂载，只按 label 判会先露出上一步的
  // 「阻塞 / 待核实」黄字再换掉（2026-11-10 用户：切步骤闪一下）。读过的步骤从 lastLabels 直接出
  const [loaded, setLoaded] = useState<{ identity: string; label: string | null } | null>(null);
  const label =
    loaded?.identity === identity ? loaded.label : (lastLabels.get(identity) ?? null);
  useEffect(() => {
    if (paths.length === 0) {
      setLoaded({ identity, label: null });
      return;
    }
    let cancelled = false;
    Promise.all(
      paths.map(async (path) => {
        try {
          return { path, text: (await readResearchFile(root, path)).text };
        } catch {
          return { path, text: "" };
        }
      }),
    ).then((files) => {
      const next = stepEvidenceLabel(stepEvidenceSummaryOf(files));
      lastLabels.set(identity, next);
      if (!cancelled) setLoaded({ identity, label: next });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  if (!label) return null;
  const warn = label.startsWith("阻塞") || label.includes("待核实");
  return (
    <span
      className={`min-w-0 truncate text-xs ${warn ? "text-warn-text" : "text-l3"}`}
      title="报告里写下的状态和未决标记，不是系统认证"
    >
      {label}
    </span>
  );
}
