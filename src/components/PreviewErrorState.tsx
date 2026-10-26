import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

interface PreviewErrorStateProps {
  error: string;
  onRetry: () => void;
  kind: string;
  /** 给二进制等无法内嵌的文件：系统打开 / 在文件夹中显示 */
  path?: string;
}

/** 所有文件预览统一的失败态：原因、重试入口和可复制的文件类型信息。 */
export default function PreviewErrorState({
  error,
  onRetry,
  kind,
  path,
}: PreviewErrorStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm text-err-text">{kind === "文件" ? "无法预览这个文件" : `无法预览这个 ${kind} 文件`}</p>
      <p className="max-w-xl break-words text-xs text-l4">{error}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
        >
          重试
        </button>
        {path && (
          <>
            <button
              type="button"
              onClick={() => void openPath(path)}
              className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
            >
              用系统应用打开
            </button>
            <button
              type="button"
              onClick={() => void revealItemInDir(path)}
              className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
            >
              在文件夹中显示
            </button>
          </>
        )}
      </div>
    </div>
  );
}
