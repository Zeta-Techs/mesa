import { normalizeHex } from "./custom-theme.ts";

/**
 * Monaco 编辑器主题的面色，取自当前主题的 --color-editor-* 令牌。
 * Monaco 只认 `#rrggbb`（拿 editor.background / foreground 当默认词法色，三位写法直接抛
 * 「Illegal value for token color」整页崩），而打包版 CSS 压缩会把 `#111111` 缩成 `#111`、`#ffffff` 缩成 `#fff`
 * ——开发版不压缩所以看不出来（2026-10-29：打包版在文件树打开文件即「界面渲染出错」，七套浅色与纯黑都中）。
 * 这里一律规范成六位，读不懂的值（自定义主题写了别的格式）退回默认色。
 */
export function monacoEditorColors(read: (name: string) => string): Record<string, string> {
  const color = (name: string, fallback: string) => normalizeHex(read(name)) ?? fallback;
  return {
    "editor.background": color("--color-editor-bg", "#11131a"),
    "editor.foreground": color("--color-editor-fg", "#aeb6c6"),
    "editorLineNumber.foreground": color("--color-editor-line", "#525a6b"),
  };
}
