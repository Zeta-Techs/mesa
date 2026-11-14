import { lazy, Suspense, useState, type ComponentProps, type ReactNode } from "react";
import type { ReviewAnnotate } from "../draft-review";
import { saveClipboardImage } from "../clipboard-image";
import { projectFilePreviewKind } from "../project-files";
import { LoadingRows } from "./PageFrame";
import PdfContinuousView from "./PdfContinuousView";
import DocxPreview from "./DocxPreview";
import XlsxPreview from "./XlsxPreview";
import ImagePreview from "./ImagePreview";
import UnsupportedPreview from "./UnsupportedPreview";
import SlidesPreview from "./SlidesPreview";
import { FileVersionsButton, FileVersionsPanel } from "./FileVersions";
import { confirmDialog } from "./ConfirmDialog";

const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));

function PreviewContent({
  path,
  root,
  revealLine,
  revealNonce,
  onOpenFile,
  onOpenReader,
  leading,
  trailing,
  hideFileName,
  onAnnotate,
  onDirtyChange,
  onOrganize,
  readOnly,
  hideReadOnlyToolbar,
}: {
  path: string;
  root: string;
  revealLine?: number | null;
  revealNonce?: number;
  onOpenFile?: (absPath: string) => void;
  /** 「⛶ 沉浸阅读」入口：PDF 预览顶栏与 md 阅读态工具条共用；缺省不渲染该按钮 */
  onOpenReader?: () => void;
  /** 文本预览标题栏左侧。审阅里用来放收起后的展开按钮。 */
  leading?: ReactNode;
  /** 预览工具条右侧附加操作（如「文件版本」「新窗口」） */
  trailing?: ReactNode;
  /** 宿主头已显示文件名时不重复显示文件名 */
  hideFileName?: boolean;
  /** 审阅划选：把选段和批注追加进意见框。只对 md 阅读态生效。 */
  onAnnotate?: ReviewAnnotate;
  /** PDF 选段「整理为笔记」（项目文件页接线，pdf-organize.ts） */
  onOrganize?: ComponentProps<typeof PdfContinuousView>["onOrganize"];
  /** 脏状态上报（只有文本编辑态会脏）：宿主用来在切换/关闭预览前确认丢弃 */
  onDirtyChange?: (dirty: boolean) => void;
  readOnly?: string;
  hideReadOnlyToolbar?: boolean;
  /** 审阅里不挂「文件版本」：审阅的是工作副本，历史版本在项目文件页看 */
  hideVersions?: boolean;
}) {
  const kind = projectFilePreviewKind(path);
  const frame = "flex min-h-0 flex-1 flex-col";
  if (kind === "pdf") {
    return (
      <div className={`${frame} overflow-hidden`}>
        <PdfContinuousView
          path={path}
          cwdHint={root}
          maxFitMultiplier={1.5}
          onOpenReader={onOpenReader}
          onOrganize={onOrganize}
          onCaptureReview={
            onAnnotate
              ? async (blob, page, fileName, comment) => {
                  try {
                    const markPath = await saveClipboardImage(await blob.arrayBuffer(), "png");
                    return onAnnotate(`PDF 第 ${page} 页圈选`, fileName, comment, markPath);
                  } catch (reason) {
                    return String(reason);
                  }
                }
              : undefined
          }
        />
      </div>
    );
  }
  if (kind === "docx") {
    return (
      <div className={frame}>
        <DocxPreview path={path} cwdHint={root} />
      </div>
    );
  }
  if (kind === "xlsx") {
    return (
      <div className={`${frame} overflow-hidden`}>
        <XlsxPreview path={path} cwdHint={root} compact />
      </div>
    );
  }
  if (kind === "image") {
    return (
      <div className={`${frame} overflow-auto overscroll-none`}>
        <ImagePreview path={path} cwdHint={root} onAnnotate={onAnnotate} />
      </div>
    );
  }
  if (kind === "slides") {
    return (
      <div className={frame}>
        <SlidesPreview path={path} cwdHint={root} />
      </div>
    );
  }
  if (kind === "legacy-doc") {
    return (
      <div className={frame}>
        <UnsupportedPreview
          path={path}
          cwdHint={root}
          convertible
          hint="旧版 Office 或 OpenDocument 文档：用 Word / PowerPoint 另存为 .docx / .pptx 后可以在这里预览。"
        />
      </div>
    );
  }
  return (
    <div className={frame}>
      <Suspense
        fallback={
          <div className="min-h-0 flex-1 px-4">
            <LoadingRows />
          </div>
        }
      >
        <FilePreviewEditor
          path={path}
          root={root}
          revealLine={revealLine}
          revealNonce={revealNonce}
          onOpenFile={onOpenFile}
          hideImmersive
          onOpenReader={onOpenReader}
          leading={leading}
          trailing={trailing}
          hideFileName={hideFileName}
          onAnnotate={onAnnotate}
          onDirtyChange={onDirtyChange}
          readOnly={readOnly}
          hideReadOnlyToolbar={hideReadOnlyToolbar}
        />
      </Suspense>
    </div>
  );
}

const BINARY_PREVIEW_KINDS = new Set(["pdf", "docx", "xlsx", "image", "slides", "legacy-doc"]);

export default function ProjectFilePreview(props: ComponentProps<typeof PreviewContent>) {
  const [versionsPath, setVersionsPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  async function openVersions() {
    if (dirty && !(await confirmDialog("有未保存的编辑，查看历史将放弃这些编辑，继续？", { danger: true, confirmText: "查看历史", focusCancel: true }))) return;
    setDirty(false); props.onDirtyChange?.(false); setVersionsPath(props.path);
  }
  const kind = projectFilePreviewKind(props.path);
  const isBinary = BINARY_PREVIEW_KINDS.has(kind);
  const versionsBtn = !props.readOnly && !props.hideVersions
    ? <FileVersionsButton root={props.root} path={props.path} onOpen={openVersions} />
    : null;
  const combinedTrailing = versionsBtn || props.trailing ? <>{versionsBtn}{props.trailing}</> : undefined;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {versionsPath === props.path && !props.readOnly ? <FileVersionsPanel root={props.root} path={props.path} onClose={() => setVersionsPath(null)} /> : <>
      {isBinary && combinedTrailing && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-hairline bg-strip px-3 py-1 text-xs empty:hidden">
          {combinedTrailing}
        </div>
      )}
      <PreviewContent
        {...props}
        trailing={isBinary ? undefined : combinedTrailing}
        onDirtyChange={(value) => { setDirty(value); props.onDirtyChange?.(value); }}
      />
    </>}
  </div>;
}
