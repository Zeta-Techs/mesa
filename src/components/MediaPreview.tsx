import { memo, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { formatBytes } from "../image-view";
import { useFileVersion } from "../file-watch";

/**
 * 音视频预览（2026-10-26：原先报「二进制文件不支持预览」）。走 asset 协议流式播放，几百 MB 的录像也不用整份读进内存；
 * 每个文件先经后端读取白名单（grant_media_url）放行。WebView 放不了的编码（mkv、avi、部分 aiff）提示用系统应用打开。
 */
function MediaPreview({
  path,
  cwdHint,
  kind,
}: {
  path: string;
  cwdHint: string | null;
  kind: "audio" | "video";
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playErr, setPlayErr] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const version = useFileVersion(path);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError(null);
    setPlayErr(false);
    setInfo(null);
    invoke<string>("grant_media_url", { path, cwdHint })
      .then((abs) => {
        if (cancelled) return;
        // 版本号挂在地址上：同名文件重新生成后播放器重新取
        setSrc(`${convertFileSrc(abs)}?v=${version}`);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    invoke<{ size: number }>("file_stamp", { path, cwdHint })
      .then((s) => {
        if (!cancelled) setInfo(formatBytes(s.size));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, version]);

  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {name}
        </span>
        {info && <span className="shrink-0 tabular-nums text-l4">{info}</span>}
        <button
          type="button"
          onClick={() => void openPath(path).catch((e) => setError(String(e)))}
          className="ml-auto shrink-0 rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
        >
          用系统应用打开
        </button>
      </div>
      {error ? (
        <p className="p-3 text-sm text-err-text">{error}</p>
      ) : !src ? (
        <p className="p-3 text-sm text-l4">正在准备播放…</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-inset p-3">
          {kind === "video" ? (
            <video
              key={src}
              src={src}
              controls
              preload="metadata"
              onError={() => setPlayErr(true)}
              className="max-h-full max-w-full rounded-sm bg-black"
            />
          ) : (
            <audio key={src} src={src} controls preload="metadata" onError={() => setPlayErr(true)} className="w-full max-w-xl" />
          )}
          {playErr && (
            <p className="text-xs text-warn-text">
              这个{kind === "video" ? "视频" : "音频"}的编码在 Mesa 里放不了（常见于 mkv、avi 或压缩过的 aiff），请用系统应用打开。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(MediaPreview);
