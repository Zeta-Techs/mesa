import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Modal } from "./Modal";
import HelpRequestCards from "./HelpRequestCards";
import { primaryActionClass, quietActionClass } from "./PageFrame";
import { buildWorkspaceTerminalRequest, resolveStepLaunchByWorkspace } from "../pipeline-start";
import { deliverHelpPrompt, helpAnsweredUnsent, helpItemsSignature } from "../help-requests";
import { toast } from "../toast";
import type { HelpRequestDto, WorkspaceDto } from "../types";

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
  // 这次弹层里勾了「以后同类照此办」的条目：交给 Agent 时告诉它已记进项目知识
  const [remembered, setRemembered] = useState<Set<string>>(new Set());

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
          setRemembered(new Set());
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
    setRemembered(new Set());
  }

  /** 打开人工请求对应的对话；带 prompt 时是「交给 Agent 继续」：先建好请求再标「已送」，建不成不标 */
  async function openTerminal(target: HelpRequestDto, prompt?: string) {
    let req: Parameters<typeof setPendingTerminal>[0];
    try {
      const workspaces = await invoke<WorkspaceDto[]>("list_workspaces");
      const ws =
        workspaces.find((w) => w.id === target.workspaceId) ??
        workspaces.find((w) => w.worktreePath === target.root);
      if (ws) {
        // B1：help-wanted 也是步骤工作区语境——步骤槽绑定作预填
        //（该入口 resume 优先，绑定只在无会话回落时生效）
        const stepL = await resolveStepLaunchByWorkspace(ws, useAppStore.getState().profiles);
        req = await buildWorkspaceTerminalRequest(
          ws,
          prompt,
          prompt
            ? { autoStart: true, resumeSession: true, stepLaunch: stepL ?? undefined }
            : { stepLaunch: stepL ?? undefined },
        );
      } else {
        req = {
          cwd: target.root,
          extraEnv: {},
          title: target.workspaceName ?? target.repoName,
          ...(prompt ? { initialPrompt: prompt } : {}),
        };
      }
    } catch (reason) {
      // 弹层已关、不落错误面就等于点了没反应（workspace_env_for 失败等后端异常会走到这里）
      toast(`打不开终端：${String(reason)}`, "error");
      return;
    }
    // 只有接回原对话且自动发出的才算「已送」（2026-11-03 自查）：主仓根来的请求、要重选连接的，
    // 回答只是填进新标签的输入里，人没点启动就关掉会丢——不标已送，收件箱继续提醒
    if (prompt && req.autoStart) {
      try {
        await invoke<number>("help_request_mark_sent", { root: target.root });
      } catch (reason) {
        toast(`回答已送出，但没能标记为已送：${String(reason)}`, "warning");
      }
      bumpHelpRefresh();
    } else if (prompt) {
      toast("回答已填进对话的输入里，启动发出后才算送到；送到前待处理里会一直留着这一条。", "info");
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
              const count = target.items.filter((i) => remembered.has(i.id)).length;
              close();
              void openTerminal(target, answered > 0 ? deliverHelpPrompt(answeredItems, count) : undefined);
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
        onRemembered={(id) => setRemembered((prev) => new Set(prev).add(id))}
      />
    </Modal>
  );
}
