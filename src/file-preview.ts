/** 后端读取快照：只有完整、可写的文本文件才携带保存版本。 */
export interface FilePreviewSnapshot {
  text: string;
  truncated: boolean;
  revision: string | null;
  readOnlyReason: string | null;
  /** 不是 UTF-8 时认出来的编码（GBK、Big5、UTF-16LE…）；保存时按它写回。UTF-8 为 null / 缺省 */
  encoding?: string | null;
}

/** 保存期间继续输入时，只更新磁盘基线，不能把后输入的内容标成已保存。 */
export function previewSaveCompletion(
  submitted: string,
  current: string,
  revision: string,
  encoding: string | null = null,
) {
  return {
    snapshot: { text: submitted, truncated: false, revision, readOnlyReason: null, encoding } satisfies FilePreviewSnapshot,
    dirty: current !== submitted,
  };
}

/** 编码名给人看的写法：gb18030 / GBK 都叫 GBK（同一家族，人只认这个名字） */
export function encodingLabel(name: string): string {
  const n = name.toLowerCase();
  if (n === "gbk" || n === "gb18030") return "GBK";
  if (n === "big5") return "Big5";
  if (n === "shift_jis") return "Shift_JIS";
  if (n === "euc-kr") return "EUC-KR";
  if (n.startsWith("windows-125")) return `Windows-${n.slice(8)}`;
  return name.toUpperCase();
}
