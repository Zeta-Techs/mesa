import { useEffect, useState } from "react";
import { researchRelativePath } from "../research-report";
import { readResearchFile } from "../research-report-load";
import { stepEvidenceLabel, stepEvidenceSummaryOf } from "../step-evidence";
import type { ProjectStepDto, WorkspaceDto } from "../types";

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
  const key = JSON.stringify([root, paths, refreshToken]);
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (paths.length === 0) {
      setLabel(null);
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
      if (!cancelled) setLabel(stepEvidenceLabel(stepEvidenceSummaryOf(files)));
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
