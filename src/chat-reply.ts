/** 聊天层对长回复和待确认的整理。不改会话原文。 */

export interface ReplySection {
  title: string;
  /** 标题级别：Markdown 的 # 数（1–3），冒号短行按 3 级排；首个标题前的引子为 0 */
  level: number;
  body: string;
}

const MD_HEADING = /^#{1,3}\s+\S/;
/** 冒号收尾的独立短行（「验收摘要：」「尚未验证：」这类报告小节）。
 *  句子里带句读、列表项、加粗开头的都是正文里的引子（「想象你去餐厅吃饭：」「它做的事是：」），
 *  当小标题会把下面的列表折走（2026-10-17 用户截图：解释 API 的回答被折成一串空标题）。 */
const COLON_HEADING = /^[^\s#>*\-+\d`|][^。！？.!?，,；;]{1,17}[：:]$/;

/** 回复够长才分节可折：短回答整段照常排版，折叠只帮长报告理结构 */
export const REPLY_FOLD_MIN_CHARS = 1500;

/** colonTitles = 冒号行也算小标题。回复里已经用 # 标题分节时不算：那时冒号行是正文里引出下文的话
 *  （2026-10-19 用户实测排版题：「标注语言的代码块示例如下：」被折成一节，把后面的代码块和引用收了进去） */
function isHeadingLine(line: string, colonTitles: boolean): boolean {
  const t = line.trim();
  if (MD_HEADING.test(t)) return t.length <= 64;
  return colonTitles && COLON_HEADING.test(t);
}

/** 长回复按小标题分节（两个以上才分）；短回复或标题不够返回 null，整段照常显示。 */
export function splitReplySections(text: string): ReplySection[] | null {
  if (text.length < REPLY_FOLD_MIN_CHARS) return null;
  const lines = text.split("\n");
  const sections: ReplySection[] = [];
  let title = "";
  let level = 0;
  let body: string[] = [];
  let fenced = false;
  const flush = () => {
    if (!title && body.every((line) => !line.trim())) return;
    sections.push({ title: title || "正文", level: title ? level : 0, body: body.join("\n").trim() });
    body = [];
  };
  let inFence = false;
  const hasMdHeading = lines.some((line) => {
    if (/^[ \t]*(?:```|~~~)/.test(line)) inFence = !inFence;
    return !inFence && MD_HEADING.test(line.trim());
  });
  for (const line of lines) {
    // 围栏代码块（``` / ~~~，含列表里缩进 ≥4 空格的围栏）里的行不是小标题：
    // def foo():、YAML 键、# 注释都会误判
    if (/^[ \t]*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      body.push(line);
      continue;
    }
    if (!fenced && isHeadingLine(line, !hasMdHeading)) {
      flush();
      const t = line.trim();
      const hashes = /^(#{1,3})\s/.exec(t);
      level = hashes ? hashes[1].length : 3;
      title = t.replace(/^#{1,3}\s+/, "");
      continue;
    }
    body.push(line);
  }
  flush();
  const titled = sections.filter((section) => section.title !== "正文");
  if (titled.length < 2) return null;
  return sections.filter((section) => section.title === "正文" ? section.body : true);
}

/** 聊天层能放的音频（与 reader.rs audio_mime_for 同一张表） */
const AUDIO_EXT = /\.(?:mp3|wav|m4a|aac|aiff?|aifc|flac|ogg|oga|opus)$/i;

/**
 * 回复里提到的本机音频文件（相对、绝对、~/ 都算；网址不算），聊天层在正文下给播放条——
 * 终端只能显示文字，放不了声音（2026-10-19 用户：读音能不能在聊天里直接播）。
 * 按空白、引号、括号、中文标点切词，去掉词尾英文标点与 Markdown 的 * _ 包裹。
 */
export function mentionedAudioFiles(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/[\s`'"()（）<>[\]，。；：！？、「」]+/)) {
    const token = raw.replace(/^[*_]+/, "").replace(/[*_.,;:!?]+$/, "");
    if (!token || token.includes("://") || !AUDIO_EXT.test(token)) continue;
    found.add(token);
  }
  return [...found];
}

/** 聊天层给播放器的视频（与 project-files.ts VIDEO_EXTS 同一张表；mkv / avi 网页内核多半放不了，卡上提示系统打开） */
const VIDEO_EXT = /\.(?:mp4|m4v|mov|webm|ogv|mkv|avi)$/i;

/**
 * 回复里提到的本机视频（2026-10-30 用户对照 Claude 客户端：生成的视频在聊天里只有一串路径）：切词口径同 mentionedAudioFiles，
 * 裸文件名也收（多半就在会话目录下）；读不到的由视频卡自己不出卡。网址不收
 */
export function mentionedVideoFiles(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/[\s`'"()（）<>[\]，。；：！？、「」]+/)) {
    const token = raw.replace(/^[*_]+/, "").replace(/[*_.,;:!?]+$/, "");
    if (!token || token.includes("://") || !VIDEO_EXT.test(token)) continue;
    found.add(token);
  }
  return [...found];
}

/** 聊天层能内嵌的图片（与 chat-image.ts / reader.rs image_mime_for 同一张表） */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/**
 * 回复里提到的本机图片（2026-10-25 用户：出图后聊天里只有一串路径，看不到图）：切词口径同 mentionedAudioFiles，
 * 但只收带目录的路径（绝对、~/、含 / 或 \ 的相对路径）——裸文件名和正文短语分不开，且常和同一张图的完整路径重复。
 * `![…](…)` 已由 Markdown 就地内嵌：它本身不列，正文别处再提到同一张图（先写一句「已生成 `x.png`」再内嵌）也不列，
 * 否则同一张图出两张（2026-10-26 用户截图）。toKey 把路径换成比较用的键（调用方按会话目录解析成绝对路径；
 * 默认只统一斜杠、去掉开头的 ./）
 */
export function mentionedImageFiles(text: string, toKey: (path: string) => string = imagePathKey): string[] {
  const found = new Set<string>();
  const embedded = new Set<string>();
  const key = (path: string) => {
    try {
      return toKey(decodeURI(path));
    } catch {
      // 不是合法的 %xx 编码：按原样比
      return toKey(path);
    }
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))[^)]*\)/g)) {
    const dest = (m[1] ?? m[2] ?? "").trim();
    if (dest) embedded.add(key(dest));
  }
  const plain = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  for (const raw of plain.split(/[\s`'"()（）<>[\]，。；：！？、「」]+/)) {
    const token = raw.replace(/^[*_]+/, "").replace(/[*_.,;:!?]+$/, "");
    if (!token || token.includes("://") || !IMAGE_EXT.test(token)) continue;
    if (!/[\\/]/.test(token)) continue;
    if (embedded.has(key(token))) continue;
    found.add(token);
  }
  return [...found];
}

function imagePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

/**
 * 一段文字是不是项目里的文件路径（回复里就地可点，md-file-links）：相对、绝对、~/ 都收，可带「:行号」，
 * 返回去掉行号与 ./ 前缀的路径；网址、带空白的、没有扩展名的、音频（另有播放条）返回 null。
 * 只是长得像——真假由后端 existing_files 按会话目录核实，核实过的才变成链接。
 */
export function fileRefPath(token: string): string | null {
  let t = token.trim();
  if (!t || /\s/.test(t) || t.includes("://")) return null;
  t = t.replace(/:\d+(?:[:-]\d+)?$/, "").replace(/^\.[\\/]/, "");
  if (!/^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) return null;
  if (AUDIO_EXT.test(t)) return null;
  return t;
}

/**
 * 反引号里其实是中文说法、不是代码（模型爱把界面按钮名、术语也包进反引号：`随手聊`、`接着做 Ccode`）：
 * 聊天里按正文排，不上行内代码的强调色。含汉字 / 假名 / 谚文、且没有路径、点号、等号、括号这类代码符号才算；
 * `notes/笔记.md`、`f(中文)` 仍是代码。
 */
export function isProseCodeSpan(text: string): boolean {
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return false;
  return !/[/\\.=_(){}[\]<>$#@:;|&*~^%`'"]/.test(text);
}

export interface FileRefHit {
  /** 在原文里的起点（已跳过包裹的 * _） */
  index: number;
  /** 原文里这一段（含行号） */
  raw: string;
  path: string;
}

/**
 * 正文（不在代码里的文字）里提到的文件路径：按空白、引号、括号、中文标点切词，剥掉词尾英文标点与
 * Markdown 的 * _ 包裹。正文里只认带目录的路径（「README.md」这种单个文件名在句子里太容易误认），
 * 行内代码里的单个文件名由调用方用 fileRefPath 直接认。
 */
export function findFileRefs(text: string): FileRefHit[] {
  const hits: FileRefHit[] = [];
  for (const m of text.matchAll(/[^\s`'"()（）<>[\]{}，。；：！？、「」『』]+/g)) {
    const word = m[0];
    const lead = /^[*_]*/.exec(word)![0].length;
    let core = word.slice(lead).replace(/[*_]+$/, "");
    // 句末标点剥掉，「:12」这种行号留着
    core = core.replace(/[.,;!?]+$/, "").replace(/:$/, "");
    const path = fileRefPath(core);
    if (!path || !/[\\/]/.test(path)) continue;
    hits.push({ index: (m.index ?? 0) + lead, raw: core, path });
  }
  return hits;
}

export interface ConfirmChoice {
  key: "y" | "n" | "esc";
  label: string;
}

/** 确认条上的按钮。登录/信任/菜单类提示不是批准题：不猜 y/n，去终端里自己选。
 *  词表保持克制——「选择」这类常见词会把真 y/n 确认题也误伤掉（2026-10-11 复核）。 */
export function confirmChoices(detail: string | null | undefined): ConfirmChoice[] {
  const text = detail ?? "";
  if (
    /登录|login|trust|信任|菜单|menu|select\b/i.test(text) &&
    !/permission|批准|权限|allow/i.test(text)
  ) {
    return [];
  }
  return [
    { key: "y", label: "批准" },
    { key: "n", label: "拒绝" },
  ];
}