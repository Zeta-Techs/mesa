/** 对话注入「自定义」的勾选模型（2026-10-17 用户三轮拍板：原文模板、可排序段落清单都嫌不方便，
 *  选定「勾选 + 补充一段话」）。盘上仍存一份模板文本，后端、渲染、旧档案都不变：
 *    [项目基本信息] → 勾中的内容段（固定标准顺序）→ 我的补充（原样文字，放最后）
 *  段之间空一行。手工改过、放不进这个形状的模板（顺序打乱、文字夹在中间）解析为 null，
 *  界面让人选「编辑源文本」或「改用勾选（按固定顺序重排）」。 */

import { RETIRED_SESSION_TEMPLATE_KEYS } from "./project-context.ts";

/** 自成一段的内容占位符：各自带段头（「项目规则：」…），可整段勾选 */
export const SECTION_KEYS = [
  "文件地图",
  "课题主题",
  "工作环境",
  "项目规则",
  "技能纪律",
  "长期知识",
  "已验收",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** 「项目基本信息」那一段：与默认模板开头一字不差 */
export const BASICS_BLOCK = [
  "你正在项目「{{项目名}}」中工作。",
  "工作方式：{{工作方式}}",
  "项目目录：{{项目目录}}",
].join("\n");

export interface SimpleTemplate {
  basics: boolean;
  /** 勾中的内容段（标准顺序） */
  sections: SectionKey[];
  /** 我的补充：原样文字，可以夹 {{项目名}} 这类名字 */
  extra: string;
}

type Block = { kind: "section"; key: SectionKey } | { kind: "text"; text: string };

const SECTION_ONLY = new RegExp(`^\\{\\{\\s*(${SECTION_KEYS.join("|")})\\s*\\}\\}$`);
/** 撤掉的占位符独占一段时渲染为空：读模板时直接略过，旧档案照样能用勾选改 */
const RETIRED_ONLY = new RegExp(`^\\{\\{\\s*(${RETIRED_SESSION_TEMPLATE_KEYS.join("|")})\\s*\\}\\}$`);

/** 段按空行切；独占一段的内容占位符 = 内容段，其余 = 文字段。 */
function splitBlocks(template: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of template.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
    const para = raw.replace(/^\n+|\s+$/g, "");
    if (!para.trim() || RETIRED_ONLY.test(para.trim())) continue;
    const hit = SECTION_ONLY.exec(para.trim());
    blocks.push(hit ? { kind: "section", key: hit[1] as SectionKey } : { kind: "text", text: para });
  }
  return blocks;
}

const rank = (key: SectionKey) => SECTION_KEYS.indexOf(key);

/** 模板 → 勾选模型；放不进「基本信息 → 内容段（标准顺序、不重复）→ 补充」的形状返回 null。 */
export function parseSimpleTemplate(template: string): SimpleTemplate | null {
  const blocks = splitBlocks(template);
  let i = 0;
  let basics = false;
  const first = blocks[0];
  if (first?.kind === "text" && first.text.trim() === BASICS_BLOCK) {
    basics = true;
    i = 1;
  }
  const sections: SectionKey[] = [];
  for (; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.kind !== "section") break;
    const last = sections[sections.length - 1];
    if (last !== undefined && rank(block.key) <= rank(last)) return null;
    sections.push(block.key);
  }
  const rest = blocks.slice(i);
  if (rest.some((block) => block.kind === "section")) return null;
  // 补充里出现与「基本信息」一字不差的一段（比如它被挪到了后面）也放不进去
  if (rest.some((block) => block.kind === "text" && block.text.trim() === BASICS_BLOCK)) return null;
  const extra = rest.map((block) => (block.kind === "text" ? block.text : "")).join("\n\n");
  return { basics, sections, extra };
}

/** 勾选模型 → 模板文本（内容段一律按标准顺序写出） */
export function serializeSimpleTemplate(value: SimpleTemplate): string {
  const sections = SECTION_KEYS.filter((key) => value.sections.includes(key));
  return [
    value.basics ? BASICS_BLOCK : "",
    ...sections.map((key) => `{{${key}}}`),
    value.extra.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 手工模板硬转勾选：认得出的段都留下，内容段按标准顺序，其余文字按原先次序并进「我的补充」。
 *  只丢顺序，不丢字。 */
export function coerceSimpleTemplate(template: string): SimpleTemplate {
  const blocks = splitBlocks(template);
  const sections = new Set<SectionKey>();
  const texts: string[] = [];
  let basics = false;
  for (const block of blocks) {
    if (block.kind === "section") sections.add(block.key);
    else if (!basics && block.text.trim() === BASICS_BLOCK) basics = true;
    else texts.push(block.text);
  }
  return {
    basics,
    sections: SECTION_KEYS.filter((key) => sections.has(key)),
    extra: texts.join("\n\n"),
  };
}

/** 内容段一行摘要（勾选标签的悬浮说明）：去掉段头和列表符号，用「 · 」连起来；空段明说会省略。 */
export function sectionSummary(
  value: string | undefined,
  key?: string,
): { text: string; empty: boolean } {
  const lines = (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { text: "当前为空，开对话时省略", empty: true };
  // 段名已经写在标签上，正文开头的「技能纪律：」不再重复
  if (key && lines.length === 1) lines[0] = lines[0]!.replace(new RegExp(`^${key}[：:]\\s*`), "");
  const body = lines.length > 1 && /[：:]$/.test(lines[0]!) ? lines.slice(1) : lines;
  const items = body.map((line) => line.replace(/^(?:[-*]\s+|\d+[.、]\s*)/, ""));
  const count = body.length > 1 ? `${body.length} 条：` : "";
  return { text: `${count}${items.join(" · ")}`, empty: false };
}
