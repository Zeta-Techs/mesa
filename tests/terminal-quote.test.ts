import assert from "node:assert/strict";
import test from "node:test";
import { askAboutText, clipNoteEntry, quoteForChat, QUOTE_MAX_CHARS } from "../src/terminal-quote.ts";

test("引用：每行加「> 」，去行尾空格、压连续空行，末尾空一行", () => {
  assert.equal(
    quoteForChat("\n  error: build failed   \n\n\n  at main.rs:12  \n\n"),
    ">   error: build failed\n>\n>   at main.rs:12\n\n",
  );
  assert.equal(quoteForChat("   \n  "), "", "全是空白不引用");
});

test("问 AI：问句在前，引用在后", () => {
  assert.equal(askAboutText("npm ERR! code E404"), "这段终端输出是什么意思？\n\n> npm ERR! code E404\n");
});

test("太长截断并写明", () => {
  const q = quoteForChat("x".repeat(QUOTE_MAX_CHARS + 50));
  assert.ok(q.includes("（后面太长，已截断）"));
  assert.ok(q.length < QUOTE_MAX_CHARS + 100);
});

test("存进笔记：小节标题带时间与来源，正文放代码块，围栏比正文里的反引号长", () => {
  const entry = clipNoteEntry({
    text: "运行 ```bash``` 失败\n",
    when: new Date(2026, 9, 17, 9, 5),
    agentLabel: "Claude Code",
    sessionTitle: "1017|修复|构建报错",
  });
  assert.ok(entry.startsWith("\n## 2026-10-17 09:05 · Claude Code · 1017|修复|构建报错\n\n````text\n"));
  assert.ok(entry.includes("运行 ```bash``` 失败\n````\n"));
});
