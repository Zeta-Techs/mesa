import { invoke } from "@tauri-apps/api/core";
// mammoth 无 ESM 默认导出（export =），同 DocxPreview 用命名空间导入
import * as mammoth from "mammoth";
import { sanitizeDocumentHtml } from "./document-html";
import { htmlPageThumb } from "./doc-thumb";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Word（docx）附件的首页预览：read_docx_bytes（同一读取白名单）→ mammoth → 清洗 → 排进一张纸。失败 null */
export async function docxFirstPageThumb(path: string, cwdHint: string | null): Promise<string | null> {
  try {
    const dto = await invoke<{ data: string }>("read_docx_bytes", { path, cwdHint });
    const result = await mammoth.convertToHtml({ arrayBuffer: base64ToBytes(dto.data).buffer as ArrayBuffer });
    return htmlPageThumb(sanitizeDocumentHtml(result.value));
  } catch {
    return null;
  }
}
