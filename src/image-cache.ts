//! 读过的本地图按路径缓存成 blob URL（聊天图片卡与 md 内嵌图共用）。
//! 切回一段带图的会话时同步拿到地址，不再先出「图片加载中」、等一趟 IPC 才换图（2026-10-25 用户：切会话图片卡一下才出来）。
//! 用 blob URL 不用 data URL：DOM 里不挂几 MB 的 base64 串，WebView 按同一地址复用已解码的图。

import { invoke } from "@tauri-apps/api/core";
import { fileStamp, stampKey } from "./file-watch.ts";

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
    /** 删掉一条（磁盘上换了版本）；不 revoke——屏上还挂着旧地址的图等新图换上 */
    delete(key: string): void {
      const old = map.get(key);
      if (!old) return;
      map.delete(key);
      total -= old.bytes;
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
/** 缓存时那一版的磁盘戳（大小 + 修改时间）：重新出图后据此换掉旧图（2026-10-26） */
const stamps = new Map<string, string | null>();
/** 预解码时读到的原图宽高：看大图灯箱首帧就按最终尺寸摆，不先按原尺寸铺一下再缩（2026-11-24 用户：点开图闪一下） */
const dims = new Map<string, { w: number; h: number }>();
/** 原图大小（字节）：灯箱信息行用 */
const sizes = new Map<string, number>();

/** 缓存里这张图的宽高（预解码读到的；svg 等读不出为 undefined） */
export function cachedImageDims(path: string): { w: number; h: number } | undefined {
  return lru.get(path) ? dims.get(path) : undefined;
}

/** 缓存里这张图的字节数 */
export function cachedImageBytes(path: string): number | undefined {
  return lru.get(path) ? sizes.get(path) : undefined;
}

/** 已缓存就同步给地址（首帧直接画图），没有返回 undefined */
export function cachedImageUrl(path: string): string | undefined {
  return lru.get(path);
}

/** 经 read_image_raw 白名单读图，转成 blob URL 存进缓存；同一路径同时只读一次 */
export function loadImageUrl(path: string, cwdHint: string | null | undefined): Promise<string> {
  const hit = lru.get(path);
  if (hit) return Promise.resolve(hit);
  return fetchImage(path, cwdHint);
}

function fetchImage(path: string, cwdHint: string | null | undefined): Promise<string> {
  const key = `${path}\u0000${cwdHint ?? ""}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  // 二进制通道直接拿字节（不经 base64 + JSON 在主线程解析），上屏前先在后台解码好：
  // 原先首次切到带图的会话，解析几 MB 字符串 + 首帧同步解码大图会顿一下（2026-10-31 用户）
  const p = Promise.all([
    invoke<unknown>("read_image_raw", { path, cwdHint: cwdHint ?? null }),
    fileStamp(path, cwdHint),
  ])
    .then(async ([raw, stamp]) => {
      const buf = rawIpcBytes(raw);
      const url = URL.createObjectURL(new Blob([buf], { type: imageMime(path) }));
      const size = await predecode(url);
      if (size) dims.set(path, size);
      else dims.delete(path);
      sizes.set(path, buf.byteLength);
      lru.set(path, url, buf.byteLength);
      stamps.set(path, stampKey(stamp));
      return url;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * 后端 tauri::ipc::Response 的原始字节：自定义协议通道到前端是 ArrayBuffer；Mac 上这条通道失败过一次，
 * Tauri 就退回 postMessage，同样的字节变成数字数组（tauri ipc/protocol.rs format_result）。
 * 数组直接塞进 Blob 存的是「137,80,78,…」这串字，图片卡成了「?」（2026-11-18 打包版用户实例）
 */
export function rawIpcBytes(raw: unknown): ArrayBuffer | Uint8Array {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error("读取图片失败：后端返回的不是字节");
}

/** 按扩展名给 mime（与后端 image_mime_for 同表；svg 必须带对类型才画得出） */
export function imageMime(path: string): string {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "gif" || ext === "webp" || ext === "png") return `image/${ext}`;
  return "application/octet-stream";
}

/** 让 WebView 先把图解码进它的图片缓存，<img> 用同一地址上屏时不再同步解码；解不出也照常交地址。顺带交回宽高 */
async function predecode(url: string): Promise<{ w: number; h: number } | null> {
  if (typeof Image === "undefined") return null;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
  return img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
}

/**
 * 缓存里的这张图磁盘上换了一版没有：换了就重读并返回新地址，没换（或读不到戳）返回 null。
 * 先用缓存画首帧、再在后台核一次——切回会话不闪，重新出图后也不会一直停在旧图
 */
export async function revalidateImageUrl(
  path: string,
  cwdHint: string | null | undefined,
): Promise<string | null> {
  if (!lru.get(path)) return null;
  const now = stampKey(await fileStamp(path, cwdHint));
  if (now === null || now === stamps.get(path)) return null;
  try {
    // 先把旧的挤掉，fetchImage 才会真去读；旧地址等屏上换完再释放
    const old = lru.get(path);
    stamps.delete(path);
    lru.delete(path);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 60_000);
    return await fetchImage(path, cwdHint);
  } catch {
    return null;
  }
}

