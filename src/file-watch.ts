import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 预览跟随磁盘变化（2026-10-26 用户「文件预览的问题全部修」）：PDF / 图片 / Word / 表格预览开着时，
 * Agent 重新渲染、重新出图后要自己换成新的一版，不能停在打开那一刻。
 */

export interface FileStamp {
  size: number;
  modifiedMs: number;
}

export function stampKey(s: FileStamp | null | undefined): string | null {
  return s ? `${s.size}:${s.modifiedMs}` : null;
}

/** 磁盘上的大小 + 修改时间（与 read_pdf_bytes 同一白名单）；读不到返回 null */
export function fileStamp(path: string, cwdHint: string | null | undefined): Promise<FileStamp | null> {
  return invoke<FileStamp>("file_stamp", { path, cwdHint: cwdHint ?? null }).catch(() => null);
}

/**
 * 这份文件在磁盘上被改写一次，返回值就加一（初值 0）。只盯这一个文件
 *（后端 watch_file：非递归监听所在文件夹、只认这个文件名，300ms 防抖）。
 * enabled=false 时不监听（比如编辑器有未保存修改时由调用方自己决定）。
 */
export function useFileVersion(path: string | null | undefined, enabled = true): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setVersion(0);
  }, [path]);
  useEffect(() => {
    if (!path || !enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    void (async () => {
      try {
        watchId = await invoke<string>("watch_file", { path });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, () => setVersion((v) => v + 1));
      } catch {
        // 监听不了（文件夹不可读等）：退回重开预览才更新
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
  }, [path, enabled]);
  return version;
}
