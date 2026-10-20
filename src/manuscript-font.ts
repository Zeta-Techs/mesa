/** 初稿正文字体。开工时在本步工作区问一次，第一次渲染就用。商量会话只改任务书。 */

export const DEFAULT_LATIN_FONT = "Times New Roman";
export const DEFAULT_CJK_FONT = "宋体";

export function manuscriptFontPrompt(markdown: string, latin: string, cjk: string): string {
  const source = markdown.trim() || "manuscript/draft.md";
  const en = latin.trim() || DEFAULT_LATIN_FONT;
  const zh = cjk.trim() || DEFAULT_CJK_FONT;
  return `正文字体定为英文 ${en}、中文 ${zh}。渲染前运行 quarto-render 技能的 scripts/manuscript_font.py（Windows 上把 python3 换成 python）：python3 <技能目录>/scripts/manuscript_font.py --root <任务书里的项目根绝对路径> --markdown ${source} --latin "${en}" --cjk "${zh}"。写完再渲这一次 PDF 和 Word，不要先渲完再重渲。脚本会把 reference-doc 写进 YAML 的 format.docx，Word 自动套 manuscript/reference.docx 的字体与样式。本机没有这套字体就停下来告诉我，不要改用别的字体。渲完告诉我两份成稿用的字体。`;
}
