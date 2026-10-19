import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  estimateBodyAfter,
  formatMB,
  slimBlockReason,
  slimResultText,
} from "../session-slim";
import type { SlimApplyDto, SlimInspectDto } from "../types";
import { InlineNotice, primaryActionClass, rowActionClass } from "./PageFrame";
import { Modal } from "./Modal";

/** 「瘦身会话」确认弹层：先说清会动什么、不动什么、原件备份在哪，用户点了才写（safety.md「会话瘦身」）。 */
export default function SessionSlimDialog({
  agent,
  filePath,
  inspect,
  runningInMesaTab,
  onClose,
  onApplied,
  onResume,
}: {
  agent: string;
  filePath: string;
  inspect: SlimInspectDto;
  /** 这条对话正开在 Mesa 的终端标签里：先关标签再瘦身，否则进程内存里还是旧历史 */
  runningInMesaTab: boolean;
  onClose: () => void;
  /** 瘦身成功后回调：调用方刷新列表并重新检测 */
  onApplied: () => void;
  /** 在 Mesa 终端里继续这条对话 */
  onResume: () => void;
}) {
  const [busy, setBusy] = useState<"only" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SlimApplyDto | null>(null);
  const block = slimBlockReason(inspect, runningInMesaTab);

  async function apply(thenResume: boolean) {
    setBusy(thenResume ? "resume" : "only");
    setError(null);
    try {
      const r = await invoke<SlimApplyDto>("session_slim_apply", {
        agent,
        filePath,
        keep: inspect.keep,
      });
      onApplied();
      if (thenResume) {
        onClose();
        onResume();
        return;
      }
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open
      title="瘦身会话"
      onClose={onClose}
      size="md"
      panelClassName="z-60"
      contentClassName="text-sm"
      footer={
        result ? (
          <>
            <button type="button" className={rowActionClass} onClick={onClose}>
              完成
            </button>
            <button
              type="button"
              className={primaryActionClass}
              onClick={() => {
                onClose();
                onResume();
              }}
            >
              在终端继续
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={rowActionClass}
              disabled={busy !== null}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className={rowActionClass}
              disabled={busy !== null || block !== null}
              onClick={() => void apply(false)}
            >
              {busy === "only" ? "瘦身中…" : "只瘦身"}
            </button>
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy !== null || block !== null}
              onClick={() => void apply(true)}
            >
              {busy === "resume" ? "瘦身中…" : "瘦身并在终端继续"}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2 leading-6 text-l2">
          <InlineNotice tone="ok">{slimResultText(result)}</InlineNotice>
          <div className="text-xs leading-5 text-l3">
            原会话文件已完整备份（保留最近 3 份），需要时可从备份还原：
            <button
              type="button"
              className="ml-1 break-all text-left underline decoration-dotted hover:text-l1"
              title="在文件夹中显示"
              onClick={() => void revealItemInDir(result.backupPath)}
            >
              {result.backupPath}
            </button>
          </div>
          <div className="text-xs leading-5 text-l3">
            如果这条对话还开在 Claude 客户端里，需要在客户端里把它归档再恢复一次，它才会读到瘦身后的记录。
          </div>
        </div>
      ) : (
        <div className="space-y-2 leading-6 text-l2">
          {error && <InlineNotice tone="err">{error}</InlineNotice>}
          {block && <InlineNotice tone="warn">{block}</InlineNotice>}
          <p>
            这条对话带着 {inspect.mediaCount} 张截图（{formatMB(inspect.mediaBytes)}），每次发送都要整段重发。
            Mesa 会把较早的 {inspect.removable} 张换成一行文字占位，只保留最近 {inspect.keep} 张。
          </p>
          <ul className="list-disc space-y-1 pl-5 text-l3">
            <li>
              下一次发送约 {formatMB(inspect.bodyBytes)}，瘦身后约{" "}
              {formatMB(estimateBodyAfter(inspect))}。
            </li>
            <li>你的指令、Claude 的回复和操作记录都不动，只有较早的截图画面不再随对话发送。</li>
            <li>写入前会先把原会话文件完整备份，备份保存在 Mesa 的数据目录里。</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
