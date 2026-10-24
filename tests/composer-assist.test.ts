import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMention,
  contextUsage,
  filterMesaCommands,
  lastUserText,
  mentionQueryAt,
} from "../src/composer-assist.ts";

test("@ 引用：只认行首或空白后的 @，查询不含空白", () => {
  assert.deepEqual(mentionQueryAt("看看 @src/ma", 11), { start: 3, query: "src/ma" });
  assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionQueryAt("邮箱 a@b.com", 10), null, "邮箱里的 @ 不算");
  assert.equal(mentionQueryAt("@src 再说", 7), null, "查询后有空白就结束了");
});

test("选中文件：@查询换成 @相对路径，带空格的路径加引号", () => {
  const m = mentionQueryAt("看看 @ma 这个", 6)!;
  assert.deepEqual(applyMention("看看 @ma 这个", 6, m, "src/main.rs"), {
    value: "看看 @src/main.rs  这个",
    caret: 16,
  });
  const m2 = mentionQueryAt("@no", 3)!;
  assert.equal(applyMention("@no", 3, m2, "notes/my file.md").value, '@"notes/my file.md" ');
});

test("Mesa 操作按命令名前缀或中文名匹配", () => {
  const run = () => {};
  const list = [
    { cmd: "/new", label: "新对话", hint: "", run },
    { cmd: "/fork", label: "分叉成新对话", hint: "", run },
  ];
  assert.deepEqual(filterMesaCommands(list, "f").map((c) => c.cmd), ["/fork"]);
  assert.deepEqual(filterMesaCommands(list, "分叉").map((c) => c.cmd), ["/fork"]);
  assert.equal(filterMesaCommands(list, "").length, 2);
});

test("↑ 取回上一句：跳过命令行和助手消息", () => {
  const msgs = [
    { role: "user", blocks: [{ kind: "text", text: "第一句" }] },
    { role: "assistant", blocks: [{ kind: "text", text: "回答" }] },
    { role: "user", blocks: [{ kind: "command", text: "/model x" }] },
  ];
  assert.equal(lastUserText(msgs), "第一句");
  assert.equal(lastUserText([]), null);
});

test("上下文用量：最后一条带用量的助手消息 ÷ 窗口；窗口未知不画", () => {
  const msgs = [
    { role: "assistant", usage: { input: 1000, cacheRead: 9000, cacheWrite: 0 } },
    { role: "user", usage: null },
    { role: "assistant", usage: { input: 2000, cacheRead: 60000, cacheWrite: 1000 } },
  ];
  assert.deepEqual(contextUsage(msgs, 200000), { used: 63000, ratio: 0.315 });
  assert.equal(contextUsage(msgs, null), null);
  assert.equal(contextUsage([], 200000), null);
});

test("↑ 历史：最近的在前，连着发的同一句只留一条，只认文字块", async () => {
  const { userTextHistory } = await import("../src/composer-assist.ts");
  const u = (text: string) => ({ role: "user", blocks: [{ kind: "text", text }] });
  const a = { role: "assistant", blocks: [{ kind: "text", text: "好的" }] };
  const msgs = [u("第一句"), a, u("第二句"), a, u("第二句"), { role: "user", blocks: [{ kind: "image", text: "" }] }, u("  第三句 ")];
  assert.deepEqual(userTextHistory(msgs), ["第三句", "第二句", "第一句"]);
  assert.deepEqual(userTextHistory(msgs, 2), ["第三句", "第二句"]);
  assert.deepEqual(userTextHistory([]), []);
});

test("↑ 取回上一句：第一句前面 Mesa 塞的项目说明不取回", () => {
  const msg = (text: string) => ({ role: "user", blocks: [{ kind: "text", text }] });
  assert.equal(
    lastUserText([msg("你正在项目「测试项目」中工作。\n工作方式：科研\n\n----\n\n帮我整理文献")]),
    "帮我整理文献",
  );
  assert.equal(lastUserText([msg("先这样"), msg("你正在项目「测试项目」中工作。")]), "先这样");
});
