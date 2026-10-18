import { lazy, Suspense, type ReactNode } from "react";
import { projectFilePreviewKind } from "../project-files";
import { LoadingRows } from "./PageFrame";
import PdfContinuousView from "./PdfContinuousView";
import DocxPreview from "./DocxPreview";
import XlsxPreview from "./XlsxPreview";
import ImagePreview from "./ImagePreview";

const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));

export default function ProjectFilePreview({
  path,
  root,
  onOpenFile,
  onOpenReader,
  leading,
  onAnnotate,
  onDirtyChange,
}: {
  path: string;
  root: string;
  onOpenFile?: (absPath: string) => void;
  /** 「⛶ 沉浸阅读」入口：PDF 预览顶栏与 md 阅读态工具条共用；缺省不渲染该按钮 */
  onOpenReader?: () => void;
  /** 文本预览标题栏左侧。审阅里用来放收起后的展开按钮。 */
  leading?: ReactNode;
  /** 审阅划选：把选段和批注追加进意见框。只对 md 阅读态生效。 */
  onAnnotate?: (
    text: string,
    fileName: string,
    comment: string,
  ) => string | null;
  /** 脏状态上报（只有文本编辑态会脏）：宿主用来在切换/关闭预览前确认丢弃 */
  onDirtyChange?: (dirty: boolean) => void;
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
        <ImagePreview path={path} cwdHint={root} />
      </div>
    );
  }
  if (kind === "legacy-doc") {
    return (
      <p className="px-3 py-4 text-sm text-l3">
        旧版 .doc 不能内嵌预览，请用 Word 另存为 .docx 后再打开。
      </p>
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
          onOpenFile={onOpenFile}
          hideImmersive
          onOpenReader={onOpenReader}
          leading={leading}
          onAnnotate={onAnnotate}
          onDirtyChange={onDirtyChange}
        />
      </Suspense>
    </div>
  );
}
