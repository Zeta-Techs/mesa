/**
 * 文件类型小图标（项目文件树、改动面板、附件卡等文件列表的行首标识）：扩展名 → 图形 + 固定识别色。
 * 图形是线条图标（与文件夹图标同一套 Lucide 线条，FileTypeMark 负责画），颜色不随主题变化
 * （同 VS Code 文件图标的固定配色，靠颜色认类型）。2026-10-26 用户拍板由彩色字块（PDF / W / M↓ 铺底）
 * 改为线条图标 + 类型色：字块每行一块底色太抢眼，和文件夹的线条图标也不是一套。
 * 未收录的类型返回 null，调用方画通用文件图标，不留空槽——
 * 空槽让一列文件里有的有符号、有的没有，看着像漏渲染（2026-10-17 用户截图）。纯逻辑，无渲染依赖。
 */

/** 图形种类（FileTypeMark 映射到 Lucide 图标）：类型靠图形 + 颜色两头认，PDF 与纯文本同形不同色 */
export type FileGlyph =
  | "pdf"
  | "word"
  | "sheet"
  | "slides"
  | "note"
  | "text"
  | "citation"
  | "code"
  | "braces"
  | "config"
  | "terminal"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "backup";

export interface FileTypeIcon {
  glyph: FileGlyph;
  /** 固定识别色（hex，深色/浅色主题下均可读） */
  color: string;
}

const ic = (glyph: FileGlyph, color: string): FileTypeIcon => ({ glyph, color });

const MARKDOWN = ic("note", "#5ca861");
const REACT = ic("code", "#61dafb");
const TS = ic("code", "#3178c6");
const JS = ic("code", "#c9a227");
const C_LIKE = ic("code", "#649ad2");
const JSON_ = ic("braces", "#a8a832");
const CONFIG = ic("config", "#9c9c9c");
const TEX = ic("code", "#4a9e8e");
const YAML = ic("config", "#cc3e44");
const SHELL = ic("terminal", "#8fbc5a");
const TEXT = ic("text", "#9c9c9c");
const CITATION = ic("citation", "#d4a017");
const IMAGE = ic("image", "#a074c4");
const WORD = ic("word", "#2b6cb0");
const SHEET = ic("sheet", "#217346");
const SLIDES = ic("slides", "#c43e1c");
const AUDIO = ic("audio", "#c06c9c");
const VIDEO = ic("video", "#c06c9c");
const ARCHIVE = ic("archive", "#9c9c9c");

const EXT_ICONS: Record<string, FileTypeIcon> = {
  md: MARKDOWN,
  markdown: MARKDOWN,
  mdx: MARKDOWN,
  qmd: MARKDOWN,
  tsx: REACT,
  jsx: REACT,
  ts: TS,
  mts: TS,
  cts: TS,
  js: JS,
  mjs: JS,
  cjs: JS,
  rs: ic("code", "#dea584"),
  py: ic("code", "#4b8bbe"),
  go: ic("code", "#29a8c9"),
  java: ic("code", "#cc7832"),
  c: C_LIKE,
  h: C_LIKE,
  cpp: C_LIKE,
  cc: C_LIKE,
  cxx: C_LIKE,
  json: JSON_,
  jsonc: JSON_,
  jsonl: JSON_,
  ndjson: JSON_,
  toml: CONFIG,
  ini: CONFIG,
  cfg: CONFIG,
  conf: CONFIG,
  env: CONFIG,
  lock: CONFIG,
  xml: ic("code", "#e37933"),
  csl: ic("code", "#e37933"),
  tex: TEX,
  ltx: TEX,
  sty: TEX,
  cls: TEX,
  bst: TEX,
  ipynb: ic("code", "#f37626"),
  r: ic("code", "#276dc3"),
  yaml: YAML,
  yml: YAML,
  html: ic("code", "#e34c26"),
  htm: ic("code", "#e34c26"),
  css: ic("code", "#519aba"),
  scss: ic("code", "#c6538c"),
  vue: ic("code", "#41b883"),
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  txt: TEXT,
  log: TEXT,
  bib: CITATION,
  ris: CITATION,
  enw: CITATION,
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  svg: IMAGE,
  pdf: ic("pdf", "#e5534b"),
  docx: WORD,
  doc: WORD,
  xlsx: SHEET,
  xlsm: SHEET,
  xls: SHEET,
  ods: SHEET,
  csv: SHEET,
  tsv: SHEET,
  pptx: SLIDES,
  ppt: SLIDES,
  odp: SLIDES,
  mp3: AUDIO,
  wav: AUDIO,
  m4a: AUDIO,
  aac: AUDIO,
  aiff: AUDIO,
  flac: AUDIO,
  ogg: AUDIO,
  mp4: VIDEO,
  mov: VIDEO,
  webm: VIDEO,
  mkv: VIDEO,
  zip: ARCHIVE,
  gz: ARCHIVE,
  tgz: ARCHIVE,
  "7z": ARCHIVE,
  rar: ARCHIVE,
};

function extOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** 点开头的配置文件（extOf 认不出扩展名）按整名认 */
const NAME_ICONS: Record<string, FileTypeIcon> = {
  ".gitignore": CONFIG,
  ".gitattributes": CONFIG,
  ".editorconfig": CONFIG,
  ".env": CONFIG,
};

/** 备份副本（inbox.md.bak-xxx、x.bak）：认名字里的 .bak 段，不按原扩展名冒充原文件 */
const BACKUP_ICON: FileTypeIcon = ic("backup", "#9c9c9c");

/** 按路径取文件类型图标；无扩展名或未收录类型返回 null */
export function fileTypeIcon(path: string): FileTypeIcon | null {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (/\.bak(?:$|[-.~_])/.test(name)) return BACKUP_ICON;
  const named = NAME_ICONS[name];
  if (named) return named;
  const ext = extOf(path);
  return ext ? (EXT_ICONS[ext] ?? null) : null;
}

/** 文件树/预览可内嵌显示的图片（与 read_image_bytes 白名单一致） */
const PREVIEW_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function isPreviewableImagePath(path: string): boolean {
  const ext = extOf(path);
  return ext !== null && PREVIEW_IMAGE_EXTS.has(ext);
}
