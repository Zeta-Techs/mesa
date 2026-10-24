import { Modal } from "./Modal";
import ImagePreview from "./ImagePreview";

/**
 * 对话里的图片看大图弹层（随手聊没有右栏文件预览时用）：读图走 ImagePreview
 * （read_image_bytes 白名单，粘贴图所在 ccode/tmp 已在内），可缩放。
 * 输入框里还没发出的图不走这里，走输入框上方的看图标注台（ChatImageStage）。
 */
export default function ChatImageViewer({
  path,
  cwdHint,
  onClose,
}: {
  path: string;
  cwdHint: string | null;
  onClose: () => void;
}) {
  const name = path.split(/[\\/]/).pop() || path;
  return (
    <Modal
      open
      title={name}
      onClose={onClose}
      size="xl"
      overflow="hidden"
      panelClassName="h-[80vh]"
      contentClassName="flex flex-1 flex-col overflow-hidden rounded-md border border-hairline"
    >
      <ImagePreview path={path} cwdHint={cwdHint} />
    </Modal>
  );
}
