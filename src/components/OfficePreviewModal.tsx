import { sanitizeDocumentHtml } from "../document-html";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { hydrateMdImages } from "../md-image-hydrate";
import { renderMathInto } from "../md-math";
import { rewriteMdImageHtml } from "../reader";
import { officePreviewMode } from "../work-mode";
import { rowActionClass, InlineNotice } from "./PageFrame";
import { Modal } from "./Modal";
import PdfContinuousView from "./PdfContinuousView";
import DocxPreview from "./DocxPreview";
import XlsxPreview from "./XlsxPreview";
import ImagePreview from "./ImagePreview";

export default function OfficePreviewModal({
  path,
  root,
  onClose,
  onAskAi,
  extraAction,
  onPrevious,
  onNext,
  hasPrevious = false,
  hasNext = false,
  companionPdf,
  displayName,
}: {
  path: string;
  root: string;
  onClose: () => void;
  onAskAi?: () => void;
  extraAction?: { label: string; onClick: () => void };
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  companionPdf?: string | null;
  /** 标题用的名字（缺省取文件名；手机暂存文件带时间前缀，标题用原名） */
  displayName?: string;
}) {
  const name = displayName ?? path.split(/[\\/]/).pop() ?? path;
  const mode = officePreviewMode(path);
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const mdRef = useRef<HTMLDivElement>(null);

  const isText = mode === "text";
  const isMarkdown = isText && /\.(md|markdown|mdx|qmd)$/i.test(name);

  useEffect(() => {
    setText(null); setHtml(""); setError(null); setTruncated(false);
    if (!isText) return;
    let cancelled = false;
    invoke<{ text: string; truncated: boolean }>("read_file_preview", {
      path,
      root,
    })
      .then((r) => {
        if (!cancelled) { setText(r.text); setTruncated(r.truncated); }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [isText, path, root]);

  useEffect(() => {
    if (text == null || !isMarkdown) return;
    const raw = marked.parse(text, { async: false }) as string;
    setHtml(sanitizeDocumentHtml(rewriteMdImageHtml(raw)));
  }, [text, isMarkdown]);

  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el) return;
    hydrateMdImages(el, { fromFile: path, cwdHint: root, allowHttps: true });
  });

  useEffect(() => {
    const el = mdRef.current;
    if (!el || !html) return;
    void renderMathInto(el);
  }, [html]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const canMove = e.key === "ArrowUp" ? hasPrevious : hasNext;
      if (!canMove) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowUp") onPrevious?.();
      else onNext?.();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onPrevious, onNext, hasPrevious, hasNext]);

  let body: ReactNode;
  if (error) {
    body = <p className="text-sm text-err-text">{error}</p>;
  } else if (mode === "pdf") {
    body = (
      <PdfContinuousView path={path} cwdHint={root} maxFitMultiplier={1.5} />
    );
  } else if (mode === "image") {
    body = <ImagePreview path={path} cwdHint={root} />;
  } else if (mode === "xlsx") {
    body = <XlsxPreview path={path} cwdHint={root} compact />;
  } else if (mode === "docx") {
    body = <DocxPreview path={path} cwdHint={root} />;
  } else if (isMarkdown) {
    body =
      text == null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        <div
          ref={mdRef}
          className="md-body min-h-0 flex-1 overflow-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
  } else if (isText) {
    body =
      text == null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-mono text-xs text-l2">
          {text}
        </pre>
      );
  } else {
    body = companionPdf ? <div className="flex h-full min-h-0 flex-col">
      <p className="mb-2 text-xs text-warn-text">显示同次结果中的配套 PDF。它是独立文件，不代表 Mesa 已验证 PPT 与 PDF 内容一致；请结合原文件核对。</p>
      <PdfContinuousView path={companionPdf} cwdHint={root} maxFitMultiplier={1.5} />
    </div> : <p className="text-sm text-l3">这种文件需用系统应用打开。汇报幻灯建议让 Agent 同时交付同名 PDF，方便核对版式。</p>;
  }

  return (
    <Modal
      open
      title={name}
      onClose={onClose}
      size={mode === "xlsx" ? "xl" : "lg"}
      panelClassName={`z-50 ${
        mode === "xlsx"
          ? "h-[min(88vh,920px)] max-w-[min(96vw,1280px)] p-0"
          : "h-[80vh] max-w-4xl"
      }`}
      contentClassName={`min-h-0 flex-1 ${
        mode === "xlsx" ? "mt-0 flex flex-col" : "flex flex-col"
      }`}
    >
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={(e) => {
        if (e.key === "ArrowUp" && hasPrevious) {
          e.preventDefault();
          e.stopPropagation();
          onPrevious?.();
        } else if (e.key === "ArrowDown" && hasNext) {
          e.preventDefault();
          e.stopPropagation();
          onNext?.();
        }
      }}
      >
        <div
          className={`flex shrink-0 items-baseline gap-2 ${
            mode === "xlsx"
              ? "border-b border-hairline px-4 py-2.5"
              : "mb-3"
          }`}
        >
          <h2 className="min-w-0 truncate text-base font-semibold text-l1">
            {name}
          </h2>
          <span
            className="min-w-0 truncate font-mono text-micro text-l4"
            title={path}
          >
            {path}
          </span>
          {(onPrevious || onNext) && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button type="button" className={rowActionClass} onClick={onPrevious} disabled={!hasPrevious} title="上一个文件（↑）">↑</button>
              <button type="button" className={rowActionClass} onClick={onNext} disabled={!hasNext} title="下一个文件（↓）">↓</button>
            </span>
          )}
        </div>
        <div
          className={
            mode === "xlsx" || mode === "pdf"
              ? // pdf/xlsx 自带滚动容器与缩放锚点：外层只给有界高度、禁再滚动
                // （外层 overflow-auto 会让内层滚动容器撑到全文高度永不滚动，
                //   缩放锚点修正写进不滚的容器 = 错位；整篇超高内容还会触发
                //   WKWebView 瓦片黑屏）
                "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "min-h-0 flex-1 overflow-auto"
          }
        >
          {truncated && <InlineNotice tone="warn" className="mb-2">只显示文件前半部分，不能据此确认完整内容。</InlineNotice>}
          {body}
        </div>
        <div
          className={`flex shrink-0 justify-end gap-2 ${
            mode === "xlsx" ? "border-t border-hairline px-4 py-2.5" : "mt-3"
          }`}
        >
          {mode === "external" && <>
            <button type="button" className={rowActionClass} onClick={() => void openPath(path).catch((e) => setError(String(e)))}>用系统应用打开原文件</button>
            <button type="button" className={rowActionClass} onClick={() => void revealItemInDir(path).catch((e) => setError(String(e)))}>显示文件位置</button>
          </>}
          {extraAction && (
            <button
              type="button"
              className={rowActionClass}
              onClick={extraAction.onClick}
            >
              {extraAction.label}
            </button>
          )}
          {onAskAi && (
            <button type="button" className={rowActionClass} onClick={onAskAi}>
              问 AI
            </button>
          )}
          <button type="button" className={rowActionClass} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Modal>
  );
}
