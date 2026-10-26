import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useEffect, useState } from "react";
import { FileQuestion } from "lucide-react";
import { officeConverterAvailable } from "../office-convert";

const OfficePdfView = lazy(() => import("./OfficePdfView"));

/**
 * 「这种文件本来就不在 Mesa 里预览」的中性态（2026-10-26）：二进制、压缩包、旧版 .doc 等。
 * 原先和读取失败共用红字报错 + 一个点了没用的「重试」；这里只说明白，给系统打开 / 在文件夹中显示。
 */
export default function UnsupportedPreview({
  path,
  hint,
  convertible = false,
  cwdHint = null,
}: {
  path: string;
  /** 补一句怎么办（如「用 Word 另存为 .docx 后可在这里预览」） */
  hint?: string;
  /** 旧版 Office / OpenDocument：装了 LibreOffice 时可以转成 PDF 在这里看 */
  convertible?: boolean;
  cwdHint?: string | null;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [canConvert, setCanConvert] = useState(false);
  const [asPdf, setAsPdf] = useState(false);
  useEffect(() => {
    if (convertible) void officeConverterAvailable().then(setCanConvert);
  }, [convertible]);
  useEffect(() => setAsPdf(false), [path]);
  if (asPdf) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
          <span className="truncate text-l3">{path.split(/[\\/]/).pop()}</span>
          <span className="text-l4">LibreOffice 转出的 PDF</span>
          <button
            type="button"
            onClick={() => void openPath(path).catch((e) => setErr(String(e)))}
            className="ml-auto rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
          >
            用系统应用打开
          </button>
        </div>
        <Suspense fallback={null}>
          <OfficePdfView path={path} cwdHint={cwdHint} />
        </Suspense>
      </div>
    );
  }
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
        {canConvert && (
          <button
            type="button"
            onClick={() => setAsPdf(true)}
            className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
          >
            转成 PDF 在这里看
          </button>
        )}
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
