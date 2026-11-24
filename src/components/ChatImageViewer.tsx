import { useState } from "react";
import { createPortal } from "react-dom";
import { PanelRight, PenLine } from "lucide-react";
import { Modal } from "./Modal";
import ImagePreview from "./ImagePreview";
import { imageEditActionLabel, schematicSourceOf } from "../chat-image";

/**
 * 对话里的图片看大图灯箱（2026-11-22 用户拍板：点对话里的图默认真看图，不塞进输入框）：
 * 经 createPortal 挂到 document.body，彻底脱离 `.md-chat img`（max-height: 260px / margin: 0.4em 0）与聊天滚动容器；
 * 读图走 ImagePreview（5%–800% 滚轮/捏合缩放、拖拽平移、双击 100%/适应），
 * 顶栏提供显式「标注 / 改图」（或「改示意图」「标出来问 AI」）与「在右栏打开」入口。
 * 输入框里还没发出的附件缩略图不走这里，直接走输入框上方的看图标注台（ChatImageStage）。
 * 2026-11-24 改成灯箱：标题一行「文件名 · 尺寸 · 大小」，图直接放在弹窗面上（不再套一层带边框的面板），缩放在底部浮条。
 */
export default function ChatImageViewer({
  path,
  cwdHint,
  onClose,
  onEdit,
  onOpenSidebar,
}: {
  path: string;
  cwdHint: string | null;
  onClose: () => void;
  /** 点顶栏按钮切进标注/改图台（关闭灯箱并把图挂进输入框） */
  onEdit?: () => void;
  /** 有工作目录时可在右侧文件栏常驻预览，边看图边接着聊 */
  onOpenSidebar?: () => void;
}) {
  const name = path.split(/[\\/]/).pop() || path;
  const [meta, setMeta] = useState<string | null>(null);
  const editLabel = imageEditActionLabel(path);
  const editHint = schematicSourceOf(path)
    ? "在标注台框出要改的字、框或图标，由 AI 改图纸重渲"
    : "进入标注台框出要问或要改的地方，连同文字一起发给 AI";

  const modal = (
    <Modal
      open
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">{name}</span>
          {meta && <span className="shrink-0 text-xs font-normal tabular-nums text-l3">{meta}</span>}
        </span>
      }
      onClose={onClose}
      size="full"
      overflow="hidden"
      panelClassName="h-[88vh]"
      contentClassName="flex flex-1 flex-col overflow-hidden"
      headerActions={
        <>
          {onOpenSidebar && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSidebar();
              }}
              title="在右侧文件栏打开，方便边看图边继续聊"
              className="flex h-7 items-center gap-1 rounded-md border border-hairline px-2 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 focus-visible:outline-2 focus-visible:outline-cta"
            >
              <PanelRight size={13} strokeWidth={1.8} aria-hidden="true" />
              在右栏打开
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit();
              }}
              title={editHint}
              className="flex h-7 items-center gap-1 rounded-md border border-field bg-inset px-2.5 text-xs font-medium text-l1 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-cta"
            >
              <PenLine size={13} strokeWidth={1.8} aria-hidden="true" />
              {editLabel}
            </button>
          )}
        </>
      }
    >
      <ImagePreview path={path} cwdHint={cwdHint} hideName variant="lightbox" onMeta={setMeta} />
    </Modal>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
