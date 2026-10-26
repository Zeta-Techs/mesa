import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pdfWheelShouldZoom, pdfWheelZoomFactor } from "../reader";
import PreviewErrorState from "./PreviewErrorState";
import { useFileVersion } from "../file-watch";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 图片只读预览：png/jpg/gif/webp/svg 经 read_image_bytes（与 md 内嵌图同一通道）。
 */
function ImagePreview({
  path,
  cwdHint,
}: {
  path: string;
  cwdHint: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [scale, setScale] = useState(1);
  // 磁盘上换了一版（重新出图）：换图，缩放与滚动不动
  const fileVersion = useFileVersion(path);

  useEffect(() => {
    setUrl(null);
  }, [path, cwdHint]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const dto = await invoke<{ mime: string; data: string }>(
          "read_image_bytes",
          { path, cwdHint },
        );
        if (!cancelled) setUrl(`data:${dto.mime};base64,${dto.data}`);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, retry, fileVersion]);

  useEffect(() => {
    setScale(1);
  }, [path]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
        {url && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded-sm px-1.5 text-l3 hover:bg-hover hover:text-l1"
              onClick={() => setScale((s) => Math.max(0.25, s / 1.2))}
              title="缩小"
            >
              −
            </button>
            <button
              type="button"
              className="rounded-sm px-1.5 font-mono text-l3 hover:bg-hover hover:text-l1"
              onClick={() => setScale(1)}
              title="还原"
            >
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              className="rounded-sm px-1.5 text-l3 hover:bg-hover hover:text-l1"
              onClick={() => setScale((s) => Math.min(8, s * 1.2))}
              title="放大"
            >
              +
            </button>
          </span>
        )}
      </div>
      {error ? (
        <PreviewErrorState error={error} kind="图片" onRetry={() => {
          setRetry((v) => v + 1);
        }} />
      ) : url === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载图片…</p>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3"
          style={{
            backgroundImage:
              "repeating-conic-gradient(var(--color-inset) 0% 25%, transparent 0% 50%)",
            backgroundSize: "16px 16px",
          }}
          onWheel={(e) => {
            if (!pdfWheelShouldZoom(e)) return;
            const factor = pdfWheelZoomFactor(e.deltaY, e.deltaMode);
            if (!factor) return;
            e.preventDefault();
            setScale((s) => Math.min(8, Math.max(0.25, s * factor)));
          }}
        >
          <img
            src={url}
            alt={basename(path)}
            className="object-contain"
            style={{
              maxHeight: scale === 1 ? "100%" : undefined,
              maxWidth: scale === 1 ? "100%" : undefined,
              transform: scale === 1 ? undefined : `scale(${scale})`,
              transformOrigin: "center center",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default memo(ImagePreview);
