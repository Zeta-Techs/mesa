import type * as Monaco from "monaco-editor";

/**
 * 关掉要语言服务 worker 的功能（补全、悬停、诊断、折叠、大纲、链接、颜色……），只留语法着色。
 * Mesa 只给 Monaco 配了基础 editor worker（FilePreviewEditor 的 MonacoEnvironment），而 `import * as monaco from "monaco-editor"`
 * 会连带注册 JSON / CSS / HTML / TypeScript 的语言服务：一打开这几类文件，它们就向基础 worker 要 resetSchema、getFoldingRanges、
 * findDocumentSymbols……全是「Missing requestHandler or method」未捕获异常（2026-10-29 打包版点验：开一个 data.json 五六条）。
 * 配齐四个专用 worker 要多带几 MB（TypeScript 的尤其大），预览 / 小改用不上，所以在源头关掉。JSON 的着色走自己的 tokens，保留。
 */
export function disableWorkerLanguageFeatures(m: typeof Monaco): void {
  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    colors: false,
    foldingRanges: false,
    diagnostics: false,
    selectionRanges: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    links: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };
  for (const d of [m.css.cssDefaults, m.css.scssDefaults, m.css.lessDefaults]) d.setModeConfiguration(off);
  for (const d of [m.html.htmlDefaults, m.html.handlebarDefaults, m.html.razorDefaults]) d.setModeConfiguration(off);
  const json = { ...off, tokens: true };
  m.json.jsonDefaults.setModeConfiguration(json);
  for (const d of [m.typescript.typescriptDefaults, m.typescript.javascriptDefaults]) d.setModeConfiguration(off);
}
