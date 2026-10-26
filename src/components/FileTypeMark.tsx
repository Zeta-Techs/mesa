import {
  BookMarked,
  File,
  FileArchive,
  FileAudio,
  FileBraces,
  FileClock,
  FileCode,
  FileCog,
  FileImage,
  FilePenLine,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { fileTypeIcon, type FileGlyph } from "../file-icons";

const GLYPHS: Record<FileGlyph, LucideIcon> = {
  pdf: FileText,
  word: FileType,
  sheet: FileSpreadsheet,
  slides: Presentation,
  note: FilePenLine,
  text: FileText,
  citation: BookMarked,
  code: FileCode,
  braces: FileBraces,
  config: FileCog,
  terminal: FileTerminal,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  backup: FileClock,
};

/** 文件类型线条图标：与文件夹图标同一套 Lucide 线条，类型色上在线条上（浅色主题由 .ccode-file-glyph 压暗）；
 *  未收录类型画通用文件图标（l4 灰）。
 *  附件卡、文件选择窗的大号占位也用它（只换 size），不再铺彩色底块。 */
export function FileTypeGlyph({ path, size = 14 }: { path: string; size?: number }) {
  const icon = fileTypeIcon(path);
  const Icon = icon ? GLYPHS[icon.glyph] : File;
  return (
    <Icon
      aria-hidden="true"
      size={size}
      strokeWidth={1.8}
      className={icon ? "ccode-file-glyph shrink-0" : "shrink-0 text-l4"}
      style={icon ? ({ "--file-glyph": icon.color } as CSSProperties) : undefined}
    />
  );
}

/** 文件行行首标识：槽宽与文件夹图标同为 14px，同一层的文件名和文件夹名对齐同一列。 */
export default function FileTypeMark({ path }: { path: string }) {
  return (
    <span aria-hidden="true" className="flex w-[14px] shrink-0 justify-center">
      <FileTypeGlyph path={path} />
    </span>
  );
}
