import { lazy, Suspense, useState, type ComponentProps, type ReactNode } from "react";
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
  onOpenFile,
  onOpenReader,
  leading,
  onAnnotate,
  onDirtyChange,
  onOrganize,
  readOnly,
  hideReadOnlyToolbar,
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
  /** PDF 选段「整理为笔记」（项目文件页接线，pdf-organize.ts） */
  onOrganize?: ComponentProps<typeof PdfContinuousView>["onOrganize"];
  /** 脏状态上报（只有文本编辑态会脏）：宿主用来在切换/关闭预览前确认丢弃 */
  onDirtyChange?: (dirty: boolean) => void;
  readOnly?: string;
  hideReadOnlyToolbar?: boolean;
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
          onOpenFile={onOpenFile}
          hideImmersive
          onOpenReader={onOpenReader}
          leading={leading}
          onAnnotate={onAnnotate}
          onDirtyChange={onDirtyChange}
          readOnly={readOnly}
          hideReadOnlyToolbar={hideReadOnlyToolbar}
        />
      </Suspense>
    </div>
  );
}

export default function ProjectFilePreview(props: ComponentProps<typeof PreviewContent>) {
  const [versionsPath, setVersionsPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  async function openVersions() {
    if (dirty && !(await confirmDialog("有未保存的编辑，查看历史将放弃这些编辑，继续？", { danger: true, confirmText: "查看历史", focusCancel: true }))) return;
    setDirty(false); props.onDirtyChange?.(false); setVersionsPath(props.path);
  }
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {versionsPath === props.path && !props.readOnly ? <FileVersionsPanel root={props.root} path={props.path} onClose={() => setVersionsPath(null)} /> : <>
      {!props.readOnly && <div className="flex shrink-0 justify-end px-2"><FileVersionsButton root={props.root} path={props.path} onOpen={openVersions} /></div>}
      <PreviewContent {...props} onDirtyChange={(value) => { setDirty(value); props.onDirtyChange?.(value); }} />
    </>}
  </div>;
}
