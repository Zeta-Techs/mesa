import { invoke } from "@tauri-apps/api/core";

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
