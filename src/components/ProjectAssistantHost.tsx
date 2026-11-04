import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProjectAssistantPanel from "./ProjectAssistantPanel";
import { useAppStore } from "../store";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { toast } from "../toast";
import { runAssistantAction } from "../assistant-actions";
import { dispatchWorkOrder } from "../assistant-dispatch";
import type { ProjectConfigReadDto, ProjectDto } from "../types";

/**
 * 项目助手的唯一宿主（2026-11-04 改成全局，App 挂一份）：工作台项目头、项目页、步骤「出错了」、红色报错提示的「问问为什么」
 * 都经 store.openAssistant 叫它出来。这里补齐它要的项目信息（项目条目、步骤数），按钮与派活交给 assistant-actions / assistant-dispatch。
 */
export default function ProjectAssistantHost() {
  const req = useAppStore((s) => s.assistantReq);
  const closeAssistant = useAppStore((s) => s.closeAssistant);
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [stepCount, setStepCount] = useState(0);
  const path = req?.path ?? null;

  useEffect(() => {
    if (!path) return;
    let stale = false;
    void invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!stale) setProject(list.find((p) => samePath(p.path, path, IS_WINDOWS)) ?? null);
      })
      .catch(() => {});
    void invoke<ProjectConfigReadDto>("read_project_config", { path })
      .then((read) => {
        if (!stale) setStepCount(read.config.steps.length);
      })
      .catch(() => {
        if (!stale) setStepCount(0);
      });
    return () => {
      stale = true;
    };
  }, [path]);

  return (
    <ProjectAssistantPanel
      open={!!req}
      onClose={closeAssistant}
      projectPath={path}
      projectName={project?.name ?? path?.split(/[\\/]/).filter(Boolean).pop() ?? ""}
      project={project}
      stepCount={stepCount}
      ask={req?.question ? { question: req.question, focus: req.focus ?? null, nonce: req.nonce } : null}
      onAction={(action, turn) => {
        if (path) void runAssistantAction(action, turn, { path, project });
      }}
      onDispatch={async (order) => {
        if (!path) throw new Error("项目助手已经关了");
        const result = await dispatchWorkOrder({ order, projectPath: path, project });
        toast(result.note, "success");
        return result;
      }}
    />
  );
}
