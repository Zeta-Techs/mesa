import { File } from "lucide-react";
import { fileTypeIcon } from "../file-icons";

/** 文件行类型徽标：短标签 + 固定识别色。外层定宽槽（最长标签 PDF/CSV/RIS 也放得下），
 *  徽标在槽里居中——标签宽窄不一（M↓、PDF）时文件名仍对齐同一列。
 *  未收录类型画通用文件图标（中性灰），不留空槽：一列里有的有符号、有的没有像漏渲染。 */
export default function FileTypeMark({ path }: { path: string }) {
  const icon = fileTypeIcon(path);
  return (
    <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
      {icon ? (
        <span
          className="flex h-4 min-w-4 items-center justify-center rounded-sm px-0.5 font-mono text-micro leading-4"
          style={{ color: icon.color, backgroundColor: `${icon.color}26` }}
        >
          {icon.label}
        </span>
      ) : (
        <span className="flex h-4 w-4 items-center justify-center text-l4">
          <File size={13} strokeWidth={1.6} />
        </span>
      )}
    </span>
  );
}
