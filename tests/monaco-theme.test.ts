import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { monacoEditorColors } from "../src/monaco-theme.ts";

const SIX = /^#[0-9a-f]{6}$/;

test("打包版 CSS 压缩出的三位色规范成六位，Monaco 不再抛 Illegal value for token color", () => {
  const vars: Record<string, string> = {
    "--color-editor-bg": " #111",
    "--color-editor-fg": "#FFF",
    "--color-editor-line": "rgb(97, 97, 97)",
  };
  assert.deepEqual(monacoEditorColors((n) => vars[n] ?? ""), {
    "editor.background": "#111111",
    "editor.foreground": "#ffffff",
    "editorLineNumber.foreground": "#616161",
  });
});

test("读不到或读不懂的值退回默认色", () => {
  const colors = monacoEditorColors((n) => (n === "--color-editor-bg" ? "oklch(0.2 0 0)" : ""));
  assert.equal(colors["editor.background"], "#11131a");
  assert.equal(colors["editor.foreground"], "#aeb6c6");
});

test("App.css 里每套主题的编辑器色，原样或压缩后都能给 Monaco 用", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const values = [...css.matchAll(/--color-editor-(?:bg|fg|line):\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(values.length >= 30, `只找到 ${values.length} 个编辑器色`);
  // 压缩器的写法：#aabbcc → #abc
  const minify = (v: string) => v.replace(/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i, "#$1$2$3");
  for (const v of values) {
    for (const form of [v, minify(v)]) {
      const out = monacoEditorColors(() => form)["editor.background"];
      assert.match(out, SIX, `${form} → ${out}`);
      assert.notEqual(out, "#11131a", `${form} 被当成读不懂、落回默认色`);
    }
  }
});
