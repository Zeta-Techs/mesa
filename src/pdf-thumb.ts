import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { IS_WINDOWS } from "./hotkeys";

// 与 PdfPreview 同一个 worker 资源；本模块由输入框按需动态引入，不进主包，也不拖进整个预览组件
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 附件卡的 PDF 首页缩略图（2026-10-23 用户：拖进输入框的 PDF 要像 ChatGPT 那样看得见首页）。
 * 字节走 read_pdf_bytes（同一读取白名单：项目内、或用户拖进 / 选来的文件），pdf.js 把第一页画到小画布出 data URL。
 * 任何一步失败返回 null，卡片退回文件名。
 */
export async function pdfFirstPageThumb(path: string, cwdHint: string | null, width = 288): Promise<string | null> {
  try {
    const dto = await invoke<{ data: string }>("read_pdf_bytes", { path, cwdHint });
    const task = pdfjs.getDocument({ data: base64ToBytes(dto.data), isImageDecoderSupported: !IS_WINDOWS });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      // 按屏幕像素比出图（封顶 3 倍）：Retina 上格子 ≥160px 宽，288 像素的位图会被拉软
      const outWidth = width * Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
      const viewport = page.getViewport({ scale: outWidth / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.82);
    } finally {
      void task.destroy();
    }
  } catch {
    return null;
  }
}
