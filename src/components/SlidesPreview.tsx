import { lazy, memo, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useFileVersion } from "../file-watch";
import { officeConverterAvailable } from "../office-convert";
import PreviewErrorState from "./PreviewErrorState";

const OfficePdfView = lazy(() => import("./OfficePdfView"));

interface SlideDto {
  index: number;
  title: string;
  paragraphs: string[];
  notes: string[];
  image: string | null;
}

interface SlidesOutlineDto {
  slides: SlideDto[];
  thumbnail: string | null;
}

/**
 * PowerPoint（pptx）预览（2026-10-26：原先点开报「二进制文件不支持预览」）。
 * 默认是大纲：每页的标题、正文、第一张图和演讲者备注（office_view.rs 从文件里抽，只读）；
 * 装了 LibreOffice 时可切「看原样」转成 PDF 一页页看版式。
 */
function SlidesPreview({ path, cwdHint }: { path: string; cwdHint: string | null }) {
  const [outline, setOutline] = useState<SlidesOutlineDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [canConvert, setCanConvert] = useState(false);
  const [asPdf, setAsPdf] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const version = useFileVersion(path);

  useEffect(() => {
    void officeConverterAvailable().then(setCanConvert);
  }, []);
  useEffect(() => {
    setOutline(null);
    setAsPdf(false);
  }, [path]);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    invoke<SlidesOutlineDto>("slides_outline", { path, cwdHint })
      .then((o) => {
        if (!cancelled) setOutline(o);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, retry, version]);

  const hasNotes = outline?.slides.some((s) => s.notes.length > 0) ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {path.split(/[\\/]/).pop()}
        </span>
        {outline && <span className="shrink-0 text-l4">{outline.slides.length} 页</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {hasNotes && !asPdf && (
            <button
              type="button"
              onClick={() => setShowNotes((v) => !v)}
              className="rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
            >
              {showNotes ? "收起备注" : "显示备注"}
            </button>
          )}
          {canConvert && (
            <button
              type="button"
              onClick={() => setAsPdf((v) => !v)}
              title={asPdf ? "回到逐页大纲" : "用本机的 LibreOffice 转成 PDF，一页页看版式"}
              className={`rounded-sm px-2 py-0.5 hover:bg-hover ${asPdf ? "text-l1" : "text-l2"}`}
            >
              {asPdf ? "逐页大纲" : "看原样（PDF）"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void openPath(path).catch((e) => setError(String(e)))}
            className="rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
          >
            用系统应用打开
          </button>
        </span>
      </div>
      {asPdf ? (
        <Suspense fallback={null}>
          <OfficePdfView path={path} cwdHint={cwdHint} />
        </Suspense>
      ) : error ? (
        <PreviewErrorState error={error} kind="幻灯" path={path} onRetry={() => setRetry((v) => v + 1)} />
      ) : !outline ? (
        <p className="p-3 text-sm text-l4">正在读取幻灯…</p>
      ) : outline.slides.length === 0 ? (
        <p className="p-3 text-sm text-l4">这份幻灯里没有页</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!canConvert && (
            <p className="mb-3 text-xs text-l4">
              这里列的是每页的文字、第一张图和备注，不是版式原样；装上 LibreOffice（免费）就能在这里一页页看原样，或用系统应用打开。
            </p>
          )}
          {outline.thumbnail && (
            <figure className="mb-3">
              <img
                src={outline.thumbnail}
                alt="首页缩略图"
                className="max-h-56 max-w-full rounded-sm border border-hairline object-contain"
              />
              <figcaption className="mt-1 text-micro text-l4">文件自带的首页缩略图</figcaption>
            </figure>
          )}
          <ol className="space-y-3">
            {outline.slides.map((s) => (
              <li key={s.index} className="rounded-md border border-hairline bg-inset px-3 py-2">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-micro tabular-nums text-l4">{s.index}</span>
                  <span className="min-w-0 break-words text-sm font-medium text-l1">
                    {s.title || <span className="font-normal text-l4">（这一页没有文字）</span>}
                  </span>
                </div>
                {(s.paragraphs.length > 0 || s.image) && (
                  <div className="mt-1.5 flex gap-3 pl-5">
                    {s.paragraphs.length > 0 && (
                      <ul className="min-w-0 flex-1 list-disc space-y-0.5 pl-4 text-xs text-l2">
                        {s.paragraphs.map((p, i) => (
                          <li key={i} className="break-words">
                            {p}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.image && (
                      <img
                        src={s.image}
                        alt={`第 ${s.index} 页的图`}
                        className="max-h-40 max-w-[45%] shrink-0 rounded-sm object-contain"
                      />
                    )}
                  </div>
                )}
                {showNotes && s.notes.length > 0 && (
                  <div className="mt-1.5 border-t border-hairline pl-5 pt-1.5 text-xs text-l3">
                    <span className="text-l4">备注：</span>
                    {s.notes.join(" ")}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export default memo(SlidesPreview);
