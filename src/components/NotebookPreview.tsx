import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { sanitizeDocumentHtml } from "../document-html";
import { renderMarkdownDocument } from "../md-render";
import { renderMathInto } from "../md-math";
import { rewriteMdImageHtml } from "../reader";
import { hydrateMdImages } from "../md-image-hydrate";
import { decorateMdCodeBlocks, handleMdCodeCopyClick } from "../md-code-chrome";
import { highlightCodeBlocks } from "../code-highlight";
import { parseNotebook, type NbCell, type Notebook } from "../notebook";
import { useFileVersion } from "../file-watch";
import PreviewErrorState from "./PreviewErrorState";

function fence(lang: string, code: string): string {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

function CellView({ cell, language, index }: { cell: NbCell; language: string; index: number }) {
  const html = useMemo(() => {
    if (cell.type === "markdown") return sanitizeDocumentHtml(rewriteMdImageHtml(renderMarkdownDocument(cell.source)));
    if (cell.type === "raw") return sanitizeDocumentHtml(renderMarkdownDocument(fence("", cell.source)));
    return sanitizeDocumentHtml(renderMarkdownDocument(fence(language, cell.source)));
  }, [cell, language]);
  const outputs = useMemo(
    () =>
      cell.outputs.map((o) => {
        if (o.kind === "html") return sanitizeDocumentHtml(o.html);
        if (o.kind === "markdown") return sanitizeDocumentHtml(renderMarkdownDocument(o.md));
        return "";
      }),
    [cell],
  );
  return (
    <section className="flex gap-2" data-nb-cell={index}>
      <span className="w-10 shrink-0 pt-1 text-right font-mono text-micro text-l4">
        {cell.type === "code" ? `[${cell.execCount ?? " "}]` : ""}
      </span>
      <div className="min-w-0 flex-1">
        <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
        {cell.outputs.length > 0 && (
          <div className="mt-1 space-y-1 border-l-2 border-hairline pl-3">
            {cell.outputs.map((o, i) =>
              o.kind === "text" ? (
                <pre
                  key={i}
                  className={`max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs ${
                    o.stream === "stderr" ? "text-warn-text" : "text-l2"
                  }`}
                >
                  {o.text}
                </pre>
              ) : o.kind === "image" ? (
                <img key={i} src={o.src} alt={`单元 ${index + 1} 的输出图`} className="max-w-full bg-white" />
              ) : o.kind === "error" ? (
                <pre key={i} className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-err-text">
                  {o.traceback || `${o.name}: ${o.value}`}
                </pre>
              ) : (
                <div key={i} className="md-body overflow-x-auto" dangerouslySetInnerHTML={{ __html: outputs[i] ?? "" }} />
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Jupyter 笔记本预览：按单元显示 Markdown、代码（高亮）与输出（文字、图、表格、报错）。
 * 输出里的 HTML 走文档清洗（不跑脚本）；交互控件、plotly 只显示静态部分。整份经 read_text_document 读（不受 256 KB 截断）。
 */
function NotebookPreview({
  path,
  root,
  onShowSource,
}: {
  path: string;
  root: string;
  onShowSource: () => void;
}) {
  const [nb, setNb] = useState<Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const version = useFileVersion(path);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNb(null);
  }, [path]);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    invoke<{ text: string }>("read_text_document", { path, root })
      .then((r) => {
        if (!cancelled) setNb(parseNotebook(r.text));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, root, retry, version]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    hydrateMdImages(host, { fromFile: path, cwdHint: root, allowHttps: true });
    decorateMdCodeBlocks(host);
  });
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !nb) return;
    void highlightCodeBlocks(host);
    void renderMathInto(host);
  }, [nb]);

  const counts = nb
    ? `${nb.cells.length} 个单元 · ${nb.cells.filter((c) => c.type === "code").length} 段代码`
    : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {path.split(/[\\/]/).pop()}
        </span>
        {counts && <span className="shrink-0 text-l4">{counts}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={onShowSource} className="rounded-sm px-2 py-0.5 text-l2 hover:bg-hover" title="看 / 改原始 JSON">
            源码
          </button>
          <button
            type="button"
            onClick={() => void openPath(path).catch((e) => setError(String(e)))}
            className="rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
          >
            用系统应用打开
          </button>
        </span>
      </div>
      {error ? (
        <PreviewErrorState error={error} kind="笔记本" path={path} onRetry={() => setRetry((n) => n + 1)} />
      ) : !nb ? (
        <p className="p-3 text-sm text-l4">正在读取笔记本…</p>
      ) : (
        <div
          ref={hostRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
          onClick={(e) => {
            if (handleMdCodeCopyClick(e.target)) e.preventDefault();
          }}
        >
          {nb.cells.length === 0 ? (
            <p className="text-sm text-l4">这份笔记本是空的</p>
          ) : (
            nb.cells.map((c, i) => <CellView key={i} cell={c} language={nb.language} index={i} />)
          )}
        </div>
      )}
    </div>
  );
}

export default memo(NotebookPreview);
