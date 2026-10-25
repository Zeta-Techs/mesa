//! 读过的本地图按路径缓存成 blob URL（聊天图片卡与 md 内嵌图共用）。
//! 切回一段带图的会话时同步拿到地址，不再先出「图片加载中」、等一趟 IPC 才换图（2026-10-25 用户：切会话图片卡一下才出来）。
//! 用 blob URL 不用 data URL：DOM 里不挂几 MB 的 base64 串，WebView 按同一地址复用已解码的图。

import { invoke } from "@tauri-apps/api/core";

type Entry = { url: string; bytes: number };

/** 按条数 + 字节双上限的 LRU；淘汰时交 revoke 释放（纯逻辑，便于测试） */
export function createImageLru(opts: { capCount: number; capBytes: number; revoke: (url: string) => void }) {
  const map = new Map<string, Entry>();
  let total = 0;
  return {
    get(key: string): string | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit.url;
    },
    set(key: string, url: string, bytes: number): void {
      const old = map.get(key);
      if (old) {
        map.delete(key);
        total -= old.bytes;
        if (old.url !== url) opts.revoke(old.url);
      }
      map.set(key, { url, bytes });
      total += bytes;
      // 最新一条总留着，哪怕它自己就超了字节上限
      while (map.size > 1 && (map.size > opts.capCount || total > opts.capBytes)) {
        const [oldestKey, oldest] = map.entries().next().value as [string, Entry];
        map.delete(oldestKey);
        total -= oldest.bytes;
        opts.revoke(oldest.url);
      }
    },
    get size() {
      return map.size;
    },
    get bytes() {
      return total;
    },
  };
}

const lru = createImageLru({
  capCount: 64,
  capBytes: 128 * 1024 * 1024,
  revoke: (url) => URL.revokeObjectURL(url),
});
const inflight = new Map<string, Promise<string>>();

/** 已缓存就同步给地址（首帧直接画图），没有返回 undefined */
export function cachedImageUrl(path: string): string | undefined {
  return lru.get(path);
}

/** 经 read_image_bytes 白名单读图，转成 blob URL 存进缓存；同一路径同时只读一次 */
export function loadImageUrl(path: string, cwdHint: string | null | undefined): Promise<string> {
  const hit = lru.get(path);
  if (hit) return Promise.resolve(hit);
  const key = `${path}\u0000${cwdHint ?? ""}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = invoke<{ mime: string; data: string }>("read_image_bytes", { path, cwdHint: cwdHint ?? null })
    .then((dto) => {
      const bin = atob(dto.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: dto.mime }));
      lru.set(path, url, bytes.length);
      return url;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
