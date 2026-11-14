import { ArrowUpRight } from "lucide-react";
import { SettingsDrawerShell } from "./ProjectSettingsDrawer";
import { primaryActionClass, quietActionClass, secondaryActionClass } from "./PageFrame";
import type { QueueApproval } from "../workbench-queue";

/** 只展示通道已提供的请求；回复仍交回工作台同一条延迟发送通道。 */
export default function WorkbenchApprovalPanel({
  approval,
  project,
  onClose,
  onAnswer,
  onConversation,
}: {
  approval: QueueApproval | null;
  project: string | null;
  onClose: () => void;
  onAnswer: (decision: "allow" | "deny") => void;
  onConversation: () => void;
}) {
  const request = approval?.request;
  const content = request ? [
    ["命令原文", request.command],
    ["文件路径", request.path],
    ["改动差异", request.diff],
    ["原内容", request.oldText],
    ["新内容", request.newText],
    ["请求详情", request.detail],
    ["方案", request.plan],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0) : [];
  return (
    <SettingsDrawerShell
      className="ccode-workbench-detail"
      backdropClassName="ccode-workbench-detail-backdrop"
      open={!!approval}
      onClose={onClose}
      title={approval?.title ?? "审批详情"}
      subtitle={project ?? "审批详情"}
      headerActions={approval && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryActionClass} onClick={() => onAnswer("allow")}>允许一次</button>
          <button type="button" className={secondaryActionClass} onClick={() => onAnswer("deny")}>{approval.denyLabel}</button>
          <button type="button" className={`${quietActionClass} ml-auto gap-1 px-2.5`} onClick={onConversation}>
            回到对话
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    >
      {approval && (
        <>
          <section className="rounded-lg ccode-well px-3.5 py-2.5">
            <h3 className="mb-1 text-xs font-medium text-l3">这次回复的范围</h3>
            <p className="text-xs leading-relaxed text-l2">
              仅回答当前这一问，不更改后续审批方式。回复会在 5 秒后发送，期间可撤销；更多权限选项在原对话里选择。
            </p>
          </section>
          <dl className="divide-y divide-hairline/60 rounded-lg ccode-well px-3.5 py-1 text-xs">
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 py-2">
              <dt className="text-l3">Agent</dt>
              <dd className="text-l1">{approval.agent}</dd>
            </div>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 py-2">
              <dt className="text-l3">工具</dt>
              <dd className="break-words font-mono text-micro text-l1">{request?.toolName ?? "通道未提供"}</dd>
            </div>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 py-2">
              <dt className="text-l3">对话目录</dt>
              <dd className="break-all font-mono text-micro text-l1">{approval.conversationCwd ?? "未知"}</dd>
            </div>
          </dl>
          {content.map(([title, text]) => (
            <section key={title}>
              <h3 className="mb-2 text-xs font-medium text-l3">{title}</h3>
              <pre className="whitespace-pre-wrap break-words rounded-lg ccode-well p-3 font-mono text-xs leading-relaxed text-l1">{text}</pre>
            </section>
          ))}
          {!content.length && <p className="text-xs text-l3">通道未提供请求正文，请回到对话核对上下文。</p>}
        </>
      )}
    </SettingsDrawerShell>
  );
}
