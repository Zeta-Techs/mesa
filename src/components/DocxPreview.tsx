import { sanitizeDocumentHtml } from "../document-html";
import { lazy, memo, Suspense, useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  docxDroppedSummary,
  officeConverterAvailable,
  type DocxFeatures,
} from "../office-convert";

const OfficePdfView = lazy(() => import("./OfficePdfView"));
import { invoke } from "@tauri-apps/api/core";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";
// mammoth 无 ESM 默认导出（export =），本项目 tsconfig 未开 esModuleInterop，用命名空间导入
import * as mammoth from "mammoth";

interface DocxBytesDto {
  data: string; // base64（同 read_pdf_bytes：raw bytes 在 macOS 会退化成数字数组）
  size: number;
}

/** base64 → Uint8Array（atob 分块；与 PdfPreview 同款，独立拷贝避免本 chunk 拖入 pdf.js） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) {
    const slice = bin.slice(i, i + CHUNK);
    for (let j = 0; j < slice.length; j++) out[i + j] = slice.charCodeAt(j);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * docx 阅读版式预览（RX4a）：mammoth 把 docx 转成 HTML，复用 RX2a 的 .md-body 排版样式区。
 * 字节经 read_docx_bytes 加载（与 PDF 同一套白名单约束，50MB 上限由后端拒绝并给出提示）。
 * 白名单只限制文件读取；mammoth 输出仍须清洗，不能执行文档中的脚本或事件。
 * 图片由 mammoth 默认转成 data URI 内嵌；本组件整体被动态 import，mammoth 不进主包。
 */
function DocxPreview({
  path,
  cwdHint,
}: {
  path: string;
  /** 终端标签 cwd / 文件树根：后端白名单的第四类来源 */
  cwdHint: string | null;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);
  const [retry, setRetry] = useState(0);
  /** mammoth 显示不出来的东西（公式、修订、批注、页眉页脚…），office_view.rs 数出来 */
  const [features, setFeatures] = useState<DocxFeatures | null>(null);
  const [canConvert, setCanConvert] = useState(false);
  /** 看原样：经 LibreOffice 转成 PDF 显示 */
  const [asPdf, setAsPdf] = useState(false);
  useEffect(() => {
    void officeConverterAvailable().then(setCanConvert);
  }, []);

  // 磁盘上换了一版（Agent 重新导出 docx）：就地重转，旧内容留到新的出来，滚动位置不丢
  const fileVersion = useFileVersion(path);
  useEffect(() => {
    setHtml(null);
    setWarnings(0);
    setFeatures(null);
    setAsPdf(false);
  }, [path, cwdHint]);

  // 加载并转换
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const dto = await invoke<DocxBytesDto>("read_docx_bytes", {
          path,
          cwdHint,
        });
        if (cancelled) return;
        const bytes = base64ToBytes(dto.data);
        const result = await mammoth.convertToHtml({
          arrayBuffer: bytes.buffer as ArrayBuffer,
        });
        if (cancelled) return;
        setWarnings(result.messages.length);
        setHtml(sanitizeDocumentHtml(result.value));
        invoke<DocxFeatures>("docx_features", { path, cwdHint })
          .then((f) => {
            if (!cancelled) setFeatures(f);
          })
          .catch(() => {});
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, retry, fileVersion]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
        <span className="shrink-0 rounded-sm bg-inset px-1 text-l4">docx</span>
        {warnings > 0 && !asPdf && (
          <span
            className="shrink-0 text-l4"
            title="部分格式（如复杂文本框/域）在转换中被简化，以 Word 打开为准"
          >
            {warnings} 处格式已简化
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {canConvert && (
            <button
              type="button"
              onClick={() => setAsPdf((v) => !v)}
              title={asPdf ? "回到可选字的阅读版式" : "用本机的 LibreOffice 转成 PDF，看分页、公式、页眉页脚的原样"}
              className={`rounded-sm px-2 py-0.5 hover:bg-hover ${asPdf ? "text-l1" : "text-l2"}`}
            >
              {asPdf ? "阅读版式" : "看原样（PDF）"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void openPath(path).catch((e) => setError(String(e)))}
            className="rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
          >
            用 Word 打开
          </button>
        </span>
      </div>
      {features && !asPdf && docxDroppedSummary(features) && (
        <p className="shrink-0 border-b border-hairline bg-inset px-3 py-1 text-xs text-warn-text">
          {docxDroppedSummary(features)}
          {canConvert ? "，点「看原样（PDF）」或用 Word 打开核对。" : "，以 Word 打开为准（装了 LibreOffice 还能在这里看原样）。"}
          {features.citationFields > 0 && ` 文献引用域 ${features.citationFields} 处只显示成文字。`}
        </p>
      )}
      {asPdf ? (
        <Suspense fallback={null}>
          <OfficePdfView path={path} cwdHint={cwdHint} />
        </Suspense>
      ) : error ? (
        <PreviewErrorState error={error} kind="DOCX" path={path} onRetry={() => setRetry((v) => v + 1)} />
      ) : html === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载 docx…</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="md-body px-5 py-4"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 mammoth 转换 */
export default memo(DocxPreview);
