import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  LoadingRows,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import type { TaskCardDto } from "../types";
import { Modal } from "./Modal";

/** fuse_card_into_draft 返回：AI 提炼的结论片段（后端已脱敏截断）+ 草稿相对路径 */
interface FuseDraftDto {
  relPath: string;
  text: string;
  sessionCount: number;
}

/**
 * 「◈ 沉淀进任务书」弹层（两阶段的人拍板点）：
 * 打开即调 fuse_card_into_draft 提炼结论片段（范围 = 该卡名下会话 × 当前步骤，不写盘）；
 * 人在编辑区预览/修改后点「追加到草稿」，经 append_step_draft **追加**到草稿末尾。
 *
 * 为什么是追加而不是覆盖：想法卡是发散的头脑风暴，用它重写一份已定好的任务书方向就反了；
 * 且覆盖时唯一的防线只有这个 textarea（没有 diff、没有备份）。追加不可能删掉已有内容。
 * AI profile 沿用设置页「提炼接力/评审沉淀」（digest 功能键），未配/失败行内中文报错可重试。
 */
export default function FuseDraftModal({
  projectPath,
  card,
  stepName,
  onClose,
  onWritten,
}: {
  projectPath: string;
  card: TaskCardDto;
  stepName: string;
  onClose: () => void;
  /** 结论已追加进草稿文件：父级关闭弹层并重读草稿 */
  onWritten: () => void;
}) {
  const [draft, setDraft] = useState<FuseDraftDto | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  async function generate() {
    setError(null);
    setDraft(null);
    try {
      const res = await invoke<FuseDraftDto>("fuse_card_into_draft", {
        projectRoot: projectPath,
        taskId: card.id,
        stepName,
      });
      setDraft(res);
      setText(res.text);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, stepName]);

  async function confirm() {
    if (!draft || writing) return;
    setWriting(true);
    setError(null);
    try {
      // 追加而非覆盖：小节标题由后端按「想法：<卡名>」+ 时间戳生成，已有内容一概不动
      await invoke("append_step_draft", {
        projectRoot: projectPath,
        stepName,
        heading: `想法：${card.name}`,
        content: text,
      });
      onWritten();
    } catch (reason) {
      setError(String(reason));
      setWriting(false);
    }
  }

  return (
    <Modal open title="◈ 沉淀进任务书" onClose={onClose} size="lg">
        <p className="mb-3 text-xs text-l3">
          把「{card.name}」的讨论结论追加到「{stepName}」的 TASK.md
          {draft ? `（${draft.relPath}）` : ""}末尾；可改后再写入，已有内容不会被动。
        </p>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-field bg-canvas">
          {draft === null && !error ? (
            <div className="p-3">
              <LoadingRows compact />
            </div>
          ) : (
            <textarea
              className="h-full max-h-[38vh] min-h-40 w-full resize-none overflow-auto bg-canvas p-3 font-mono text-micro leading-5 text-l2 outline-none placeholder:text-l4"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>
        {error && (
          <div className="mt-3 flex shrink-0 items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-err-text">{error}</p>
            <button
              type="button"
              onClick={() => void generate()}
              className="shrink-0 rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover"
            >
              重试
            </button>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={writing}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="button"
            disabled={writing || draft === null || !text.trim()}
            onClick={() => void confirm()}
            className={primaryActionClass}
          >
            {writing ? "写入中…" : "追加到 TASK.md"}
          </button>
        </div>
    </Modal>
  );
}
