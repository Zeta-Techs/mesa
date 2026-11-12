import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Modal } from "./Modal";
import HelpRequestCards from "./HelpRequestCards";
import { primaryActionClass, quietActionClass } from "./PageFrame";
import { buildWorkspaceTerminalRequest, resolveStepLaunchByWorkspace } from "../pipeline-start";
import { helpAnsweredUnsent, helpItemsSignature } from "../help-requests";
import { confirmDialog } from "./ConfirmDialog";
import { toast } from "../toast";
import type { HelpRequestDto, RunDto, WorkspaceDto } from "../types";

/**
 * 人工请求卡片弹层（2026-11-02 起全局挂在 App）：工作台拍板队列、标题栏收件箱、项目页点「去回答」都原地弹出，不跳页。
 * Agent 写的票拟，点一下就是批红；回答立刻写进文件，「交给 Agent 继续」走原对话送达（同「让 Agent 按决定继续」）。
 * 不回它会按每条兜底继续，不停工。答完 / 送完 bumpHelpRefresh，让收件箱重拉
 */
export default function HelpRequestDialog() {
  const req = useAppStore((s) => s.helpViewReq);
  const setReq = useAppStore((s) => s.setHelpViewReq);
  const dismissHelpRequest = useAppStore((s) => s.dismissHelpRequest);
  const bumpHelpRefresh = useAppStore((s) => s.bumpHelpRefresh);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const [view, setView] = useState<HelpRequestDto | null>(null);

  async function load(root: string): Promise<HelpRequestDto | null> {
    const list = await invoke<HelpRequestDto[]>("list_help_requests");
    return list.find((h) => h.root === root) ?? null;
  }

  useEffect(() => {
    if (!req) return;
    const root = req;
    setReq(null);
    load(root)
      .then((found) => {
        if (found) {
          setView(found);
        } else {
          toast("这条人工请求已经处理完了", "info");
          bumpHelpRefresh();
        }
      })
      .catch((reason) => toast(`读不到人工请求：${String(reason)}`, "error"));
  }, [req, setReq, bumpHelpRefresh]);

  async function reload(root: string) {
    try {
      setView(await load(root));
    } catch {
      /* 下次打开再拉 */
    }
    bumpHelpRefresh();
  }

  function close() {
    setView(null);
  }

  async function openTerminal(target: HelpRequestDto, itemIds?: string[]) {
    let req: Parameters<typeof setPendingTerminal>[0];
    try {
      let deliveryRun: RunDto | null = null;
      if (itemIds?.length) {
        try {
          deliveryRun = await invoke<RunDto>("help_delivery_prepare", { root: target.root, itemIds, retry: false });
        } catch (reason) {
          if (!String(reason).includes("可能已发出")) throw reason;
          if (!(await confirmDialog("回答可能已经送到。请先核对原对话；只有确认没有送到，才重新发送，重复发送可能让 AI 重做业务。", { confirmText: "确认没送到，重发", danger: true }))) return;
          deliveryRun = await invoke<RunDto>("help_delivery_prepare", { root: target.root, itemIds, retry: true });
        }
      }
      const workspaces = await invoke<WorkspaceDto[]>("list_workspaces");
      if (deliveryRun?.runtime === "headless") {
        toast("回答已保存，后台按原连接与授权继续；做完照常等你评审。", "info");
        bumpHelpRefresh();
        return;
      }
      const ws =
        workspaces.find((w) => w.id === target.workspaceId) ??
        workspaces.find((w) => w.worktreePath === target.root);
      if (ws) {
        // B1：help-wanted 也是步骤工作区语境——步骤槽绑定作预填
        //（该入口 resume 优先，绑定只在无会话回落时生效）
        const stepL = await resolveStepLaunchByWorkspace(ws, useAppStore.getState().profiles);
        req = await buildWorkspaceTerminalRequest(
          ws,
          undefined,
          itemIds?.length
            ? { autoStart: true, resumeSession: true, stepLaunch: stepL ?? undefined }
            : { stepLaunch: stepL ?? undefined },
        );
      } else {
        req = {
          cwd: target.root,
          extraEnv: {},
          title: target.workspaceName ?? target.repoName,
        };
      }
      if (deliveryRun) {
        req.runId = deliveryRun.id;
        req.taskId = deliveryRun.taskId || undefined;
        req.agentId = deliveryRun.agent;
        req.profileId = deliveryRun.profileId ?? undefined;
        req.focusSession = undefined;
        req.resume = deliveryRun.sessionId ? { agentId: deliveryRun.agent, sessionId: deliveryRun.sessionId } : undefined;
        req.autoStart = Boolean(deliveryRun.profileId);
      }
    } catch (reason) {
      // 弹层已关、不落错误面就等于点了没反应（workspace_env_for 失败等后端异常会走到这里）
      toast(`打不开终端：${String(reason)}`, "error");
      return;
    }
    if (itemIds?.length) {
      toast("回答已排队，原对话空闲时发送；送到前仍保留在待处理里。", "info");
    }
    setPendingTerminal(req);
    setPage("terminal");
  }

  if (!view) return null;
  const answeredItems = helpAnsweredUnsent(view.items);
  const answered = answeredItems.length;
  return (
    <Modal
      open
      size="md"
      title={`人工请求 · ${view.repoName}${view.workspaceName ? ` / ${view.workspaceName}` : ""}`}
      description="Agent 干到一半需要你拍板。点选项或写一句就记下；答完交给 Agent，它接着干。不回它会按每条「不回时」继续。"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            title="这一处的问题先不提醒：步骤卡、聊天层、收件箱、桌宠和手机都收起；问题或回答变了会重新出现"
            onClick={() => {
              dismissHelpRequest(view.root, helpItemsSignature(view.items));
              close();
            }}
            className={quietActionClass}
          >
            忽略此来源
          </button>
          <button
            type="button"
            title={answered > 0 ? "把回答交给这一步原来的对话，让 Agent 接着干" : "打开该步骤终端，直接回答这些请求"}
            onClick={() => {
              const target = view;
              close();
              void openTerminal(target, answered > 0 ? answeredItems.map((item) => item.id) : undefined);
            }}
            className={primaryActionClass}
          >
            {answered > 0 ? `交给 Agent 继续（${answered} 条已答）` : "去终端回答"}
          </button>
        </>
      }
    >
      <HelpRequestCards
        request={view}
        onAnswered={() => void reload(view.root)}
        onRemembered={() => {}}
      />
    </Modal>
  );
}
