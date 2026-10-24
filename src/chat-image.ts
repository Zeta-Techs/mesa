//! 聊天消息里的图片路径识别纯逻辑（tests/chat-image.test.ts）。
//! 粘贴/拖拽图片后，会话文件里记下的就是一行路径文本（终端粘贴还会带 shell 单引号包裹）——
//! 渲染层据此把「整行是图片路径」的行从正文剥离，换成内嵌图片卡。

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
/** http(s) 等 URL 不是本地路径（外链图片按惯例不加载） */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 一行文本是否是本地图片路径：绝对路径（/、~/、盘符）或含分隔符的相对路径，
 *  且以图片扩展名结尾；允许 shell 引号包裹（escapeShellPath 的产物：POSIX 单引号、
 *  Windows 双引号）。裸文件名（无分隔符）不识别——无法和正文短语区分。
 *  命中返回剥离引号后的路径。 */
export function imagePathFromLine(line: string): string | null {
  const t = line.trim();
  if (!t || URL_SCHEME.test(t)) return null;
  // 剥 shell 引号包裹：单引号含 '\'' 回转，双引号含 "" 回转
  let unquoted = t;
  if (t.length > 1 && t.startsWith("'") && t.endsWith("'")) {
    unquoted = t.slice(1, -1).replace(/'\\''/g, "'");
  } else if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) {
    unquoted = t.slice(1, -1).replace(/""/g, '"');
  }
  if (!IMAGE_EXT.test(unquoted)) return null;
  const isAbs =
    unquoted.startsWith("/") ||
    unquoted.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(unquoted);
  const hasSep = unquoted.includes("/") || unquoted.includes("\\");
  return isAbs || hasSep ? unquoted : null;
}

/**
 * 改图消息里带图的两种行（2026-10-25）：「原图：路径」「标注图：路径」。
 * 不写成单独一行的路径，是因为 Claude Code 会把单独一行的图片路径升级成图片附件发给模型——看不了图的模型就报错，
 * 而改图时 AI 只要拿路径去调出图工具，不用自己看图（2026-10-25 九家逐个实测，只有 Claude Code 升级，带前缀的行九家都按文字发）
 */
const LABELED_IMAGE = /^(原图|标注图)：(.+)$/;

/** 一行是不是改图的带前缀图片行：是就返回前缀与路径 */
export function labeledImageFromLine(line: string): { label: "原图" | "标注图"; path: string } | null {
  const m = LABELED_IMAGE.exec(line.trim());
  if (!m) return null;
  const path = imagePathFromLine(m[2]);
  return path ? { label: m[1] as "原图" | "标注图", path } : null;
}

/**
 * 输入框里一张图发出去写成哪几行：普通附件一行路径（标过的换成标注图）；
 * 从对话里点进来接着改的图写「原图：」，标过再在前面加一行「标注图：」（技能 image-gen 认这两种前缀）
 */
export function attachmentLines(a: { path: string; edit?: boolean; marked?: string | null }): string[] {
  if (!a.edit) return [a.marked ?? a.path];
  return a.marked ? [`标注图：${a.marked}`, `原图：${a.path}`] : [`原图：${a.path}`];
}

/**
 * 输入框里的图会不会让模型「看」：plain = 有单独一行的图片路径（Claude Code 会当图片附件发出）；
 * marks = 只有改图的图且标过（标注只有看得见图的模型才用得上）；null = 没图，或只有没标过的改图（只交路径，不用看图）
 */
export function composerImageKind(
  attachments: readonly { path: string; isImage: boolean; edit?: boolean; marked: boolean }[],
): "plain" | "marks" | null {
  if (attachments.some((a) => a.isImage && !a.edit)) return "plain";
  if (attachments.some((a) => a.isImage && a.edit && a.marked)) return "marks";
  return null;
}

/** 把消息文本拆成「正文 + 图片路径行」：整行是图片路径的行、改图的「原图：」「标注图：」行按出现顺序抽进 images，
 *  其余行拼回正文并去掉首尾空行。 */
export function splitImagePaths(text: string): {
  text: string;
  images: string[];
} {
  const images: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    // 带前缀的先认：imagePathFromLine 会把「原图：/a.png」整行当成带分隔符的相对路径
    const p = labeledImageFromLine(line)?.path ?? imagePathFromLine(line);
    if (p) images.push(p);
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), images };
}
