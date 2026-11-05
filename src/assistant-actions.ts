/**
 * 项目助手回答里按钮的执行（2026-11-04 改成全局：项目助手能从工作台、项目页、红色报错提示里打开，按钮不再依赖工作台的状态）。
 * 一律跳到已有入口，人点了才发生：看某一步 → 工作台那一行的任务面板（不在工作台列着的退回项目页）；去评审 → 评审页；
 * 留话 → 先确认再留给那一步开着的 AI；商量 → 问 AI 开对话；报告 → 预填反馈表。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./store";
import { toast } from "./toast";
import { confirmDialog } from "./components/ConfirmDialog";
import { beginAskAi } from "./components/AskAiModal";
import { MISMATCH_EVENT, type MismatchReport } from "./chat-mismatch";
import { DISCUSS_BINDING_SLOT, slotPrefs } from "./project-agents";
import { liveRunIn, stepWorkspace } from "./assistant-dispatch";
import type { AssistantAction } from "./project-assistant";
import type { AssistantTurn } from "./project-assistant-run";
import type { ProjectDto } from "./types";

export async function runAssistantAction(
  action: AssistantAction,
  turn: AssistantTurn,
  ctx: { path: string; project: ProjectDto | null },
): Promise<void> {
  const st = useAppStore.getState();
  const { path, project } = ctx;
  const toProject = () => {
    st.closeAssistant();
    st.setSelectProjectReq(path);
    st.setPage("workspaces");
  };
  switch (action.kind) {
    case "step":
      st.closeAssistant();
      st.setWorkbenchTaskReq({ path, stepIndex: (action.step ?? 1) - 1, nonce: Date.now() });
      st.setPage("workbench");
      return;
    case "mail": {
      try {
        const { ws } = await stepWorkspace(path, action.step ?? 0);
        const run = liveRunIn(ws.worktreePath);
        if (!run) {
          toast(`第 ${action.step} 步现在没有开着的 AI，留话送不到；在这一步点「继续」接回来再说`, "info");
          return;
        }
        const ok = await confirmDialog(`把这句话留给第 ${action.step} 步的 AI？\n\n${action.text}\n\n注意：它空闲、你没在它输入框里打字时才送进对话。`, {
          confirmText: "留话",
        });
        if (!ok) return;
        await invoke<string>("mail_send", { toRun: run, text: action.text });
        toast(`已留话给第 ${action.step} 步的 AI`, "success");
      } catch (reason) {
        toast(String(reason), "error");
      }
      return;
    }
    case "review": {
      try {
        const { ws } = await stepWorkspace(path, action.step ?? 0);
        st.closeAssistant();
        st.setWorkspaceReviewRequest({ worktreePath: ws.worktreePath, runId: null, requestId: crypto.randomUUID() });
        st.setPage("terminal");
      } catch (reason) {
        toast(String(reason), "info");
      }
      return;
    }
    case "split":
      // 拆成几路做在工作台项目分组下；方案要人批准，这里只把需求复制好
      void navigator.clipboard?.writeText(action.text).catch(() => {});
      toast("要拆的事已复制，在工作台项目分组下点「拆成几个目标同时做…」粘进去", "info");
      return;
    case "project":
      toProject();
      return;
    case "agents":
      st.setProjectSurfaceReq("agents");
      toProject();
      return;
    case "profiles":
      st.closeAssistant();
      st.setPage("profiles");
      return;
    case "settings":
      st.closeAssistant();
      st.setPage("settings");
      return;
    case "discuss":
      st.closeAssistant();
      beginAskAi({
        path: "",
        name: project?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        cwd: path,
        root: path,
        reuseKey: `assistant-discuss:${path}:${Date.now()}`,
        prompt: action.text,
        workMode:
          project?.workMode === "coding" || project?.workMode === "office" || project?.workMode === "research"
            ? project.workMode
            : undefined,
        ...slotPrefs(st.profiles, project, DISCUSS_BINDING_SLOT),
      });
      return;
    case "report": {
      const report: MismatchReport = {
        title: action.text,
        detail: `项目助手判断这是 Mesa 的问题。\n你当时在做什么：`,
        snapshot: `问：${turn.question}\n\n项目助手：${turn.answer}`,
        attachLabel: "附上这次问答（项目助手的判断，已去掉密钥）",
        attachHint: "里面可能有你的项目名、文件名和出错原文，不想发就取消勾选。",
      };
      window.dispatchEvent(new CustomEvent(MISMATCH_EVENT, { detail: report }));
      return;
    }
  }
}
