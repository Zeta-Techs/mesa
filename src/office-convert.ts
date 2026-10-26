import { invoke } from "@tauri-apps/api/core";

/**
 * 装了 LibreOffice 时把 Word / 幻灯转成 PDF「看原样」（office_view.rs office_to_pdf）。
 * 有没有转换器整个进程只问一次。
 */

let converter: Promise<boolean> | null = null;

export function officeConverterAvailable(): Promise<boolean> {
  converter ??= invoke<{ available: boolean }>("office_converter")
    .then((r) => r.available)
    .catch(() => false);
  return converter;
}

/** 转好的 PDF 路径（在 Mesa 的临时目录里，读取白名单内）；同一份原文件没改过就复用上次的 */
export function convertOfficeToPdf(path: string, cwdHint: string | null): Promise<string> {
  return invoke<string>("office_to_pdf", { path, cwdHint });
}

export interface DocxFeatures {
  equations: number;
  insertions: number;
  deletions: number;
  comments: number;
  headersFooters: boolean;
  textboxes: number;
  citationFields: number;
}

/** 预览（mammoth 转出来的 HTML）里看不到的东西，列成一句给人看；全没有返回 null */
export function docxDroppedSummary(f: DocxFeatures): string | null {
  const parts: string[] = [];
  if (f.equations) parts.push(`${f.equations} 个公式`);
  if (f.insertions || f.deletions) parts.push(`${f.insertions + f.deletions} 处修订`);
  if (f.comments) parts.push(`${f.comments} 条批注`);
  if (f.headersFooters) parts.push("页眉页脚");
  if (f.textboxes) parts.push(`${f.textboxes} 个文本框`);
  return parts.length ? `这份文档里有${parts.join("、")}，下面的预览显示不出来` : null;
}
