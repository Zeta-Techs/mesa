import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { FileQuestion } from "lucide-react";

/**
 * 「这种文件本来就不在 Mesa 里预览」的中性态（2026-10-26）：二进制、压缩包、旧版 .doc 等。
 * 原先和读取失败共用红字报错 + 一个点了没用的「重试」；这里只说明白，给系统打开 / 在文件夹中显示。
 */
export default function UnsupportedPreview({
  path,
  hint,
}: {
  path: string;
  /** 补一句怎么办（如「用 Word 另存为 .docx 后可在这里预览」） */
  hint?: string;
}) {
  const [err, setErr] = useState<string | null>(null);
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <FileQuestion size={28} strokeWidth={1.5} className="text-l4" aria-hidden="true" />
      <p className="text-sm text-l2">
        {ext ? `.${ext} 文件` : "这种文件"}不能在 Mesa 里预览
      </p>
      {hint && <p className="max-w-md text-xs text-l4">{hint}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void openPath(path).catch((e) => setErr(String(e)))}
          className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
        >
          用系统应用打开
        </button>
        <button
          type="button"
          onClick={() => void revealItemInDir(path).catch((e) => setErr(String(e)))}
          className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
        >
          在文件夹中显示
        </button>
      </div>
      {err && <p className="max-w-md break-words text-xs text-err-text">{err}</p>}
    </div>
  );
}
