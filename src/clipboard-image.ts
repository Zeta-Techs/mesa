import { invoke } from "@tauri-apps/api/core";
import { imageExtFromMime } from "./terminal-input";

/** 剪贴板 / 截图图片落盘（Rust save_clipboard_image），返回绝对路径。
 *  字节作请求体原样走 IPC、扩展名放请求头：按 JSON 数字数组传，5MB 截图要编出 18.7MB 的 JSON，
 *  网页和 Rust 主线程各编解一遍，粘贴时界面整个卡住 */
export function saveClipboardImage(bytes: ArrayBuffer | Uint8Array, ext: string): Promise<string> {
  return invoke<string>(
    "save_clipboard_image",
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    { headers: { "x-image-ext": ext } },
  );
}

/** 把网页里内嵌的 data:image/... 或 blob: 图片落盘到 ccode/tmp/，供大图灯箱与标注台按本地路径读取 */
export async function saveImgSrcToTemp(src: string): Promise<string> {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(src);
  if (m) {
    const ext = imageExtFromMime(m[1]);
    const bin = atob(m[2]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return saveClipboardImage(out, ext);
  }
  const resp = await fetch(src);
  const blob = await resp.blob();
  const ext = imageExtFromMime(blob.type || "image/png");
  return saveClipboardImage(await blob.arrayBuffer(), ext);
}
