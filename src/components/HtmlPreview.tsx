import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeHtmlPreviewDocument } from "../document-html";
import {
  HTML_IFRAME_SANDBOX,
  htmlLocalImageSrcs,
  htmlStylesheetHrefs,
  isLocalStylesheetHref,
  replaceHtmlImageSrc,
  replaceStylesheetLinks,
  wrapHtmlSrcdoc,
} from "../html-preview";
import { mdImageAbsPath, resolveMdPath } from "../reader";
import PreviewErrorState from "./PreviewErrorState";

/**
 * 本地 HTML 沙箱预览：消毒后进不透明源 iframe。
 * 相对 CSS 经 read_file_preview 内联；本地图经 read_image_bytes 换成 data URL。
 */
export default function HtmlPreview({
  html,
  filePath,
  root,
  truncated = false,
}: {
  html: string;
  filePath: string;
  root: string;
  /** 编辑器只读到前 256 KB：渲染时另读整份（自包含的报告动辄几 MB，截半就排不出来） */
  truncated?: boolean;
}) {
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSrcdoc(null);
    setError(null);
    void (async () => {
      try {
        const source = truncated
          ? (await invoke<{ text: string }>("read_text_document", { path: filePath, root })).text
          : html;
        if (cancelled) return;
        const cssByHref: Record<string, string> = {};
        for (const href of htmlStylesheetHrefs(source)) {
          if (!isLocalStylesheetHref(href)) continue;
          const abs = resolveMdPath(filePath, href);
          try {
            const p = await invoke<{ text: string }>("read_file_preview", {
              path: abs,
              root,
            });
            cssByHref[href] = p.text;
          } catch {
            /* 读不到的 stylesheet 丢掉，不阻断正文 */
          }
        }
        let next = replaceStylesheetLinks(source, cssByHref);
        for (const src of htmlLocalImageSrcs(next)) {
          const abs = mdImageAbsPath(src, filePath);
          if (!abs) continue;
          try {
            const dto = await invoke<{ mime: string; data: string }>(
              "read_image_bytes",
              { path: abs, cwdHint: root },
            );
            next = replaceHtmlImageSrc(
              next,
              src,
              `data:${dto.mime};base64,${dto.data}`,
            );
          } catch {
            /* 图缺失保持原 src，iframe 里会裂，不炸预览 */
          }
        }
        if (cancelled) return;
        setSrcdoc(wrapHtmlSrcdoc(sanitizeHtmlPreviewDocument(next)));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html, filePath, root, retry, truncated]);

  if (error) {
    return (
      <PreviewErrorState
        error={error}
        kind="网页"
        onRetry={() => setRetry((n) => n + 1)}
      />
    );
  }
  if (srcdoc == null) {
    return (
      <div className="p-3">
        <p className="text-sm text-l4">正在加载网页预览…</p>
      </div>
    );
  }
  return (
    <iframe
      title="HTML 预览"
      sandbox={HTML_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      srcDoc={srcdoc}
      className="min-h-0 w-full flex-1 border-0 bg-canvas"
    />
  );
}
