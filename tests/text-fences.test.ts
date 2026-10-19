import assert from "node:assert/strict";
import test from "node:test";
import { splitFenced } from "../src/text-fences.ts";

test("没有围栏的文本原样一段", () => {
  assert.deepEqual(splitFenced("第一行\n第二行"), [{ code: false, text: "第一行\n第二行" }]);
});

test("标准围栏：语言取第一个词，前后文字各成一段", () => {
  assert.deepEqual(splitFenced("先看：\n```python\nprint(1)\nprint(2)\n```\n再说一句"), [
    { code: false, text: "先看：" },
    { code: true, lang: "python", text: "print(1)\nprint(2)" },
    { code: false, text: "再说一句" },
  ]);
});

test("行中间的三个反引号不是围栏（用户在句子里提到代码块的写法）", () => {
  const text = [
    "1. 三个二级标题",
    "4. 一个 ```python 代码块（含 # 注释和以 def 开头的行），一个没写语言的代码块",
    "5. 一段引用（> 开头）",
    "9. 一张远程图片：![x](https://example.com/a.png)",
  ].join("\n");
  assert.deepEqual(splitFenced(text), [{ code: false, text }]);
});

test("同一行写完的 ```a``` 是行内代码，不开围栏", () => {
  assert.deepEqual(splitFenced("文字```code```文字"), [{ code: false, text: "文字```code```文字" }]);
  assert.deepEqual(splitFenced("```inline``` 后面还有字\n下一行"), [
    { code: false, text: "```inline``` 后面还有字\n下一行" },
  ]);
});

test("没写语言、或首词不像语言标记时 lang 为空", () => {
  assert.deepEqual(splitFenced("```\nls\n```"), [{ code: true, lang: "", text: "ls" }]);
  assert.equal((splitFenced("```这是一整句说明文字不是语言标记啊啊啊\nx\n```")[0] as { lang: string }).lang, "");
});

test("没收尾的围栏：后面整段按代码处理（会话尾部截断）", () => {
  assert.deepEqual(splitFenced("说明\n```bash\necho 1\necho 2"), [
    { code: false, text: "说明" },
    { code: true, lang: "bash", text: "echo 1\necho 2" },
  ]);
});

test("收尾围栏必须同种符号且数量不少于开头；围栏里的短围栏不收尾", () => {
  assert.deepEqual(splitFenced("````md\n```\n内层\n```\n````\n外面"), [
    { code: true, lang: "md", text: "```\n内层\n```" },
    { code: false, text: "外面" },
  ]);
  assert.deepEqual(splitFenced("~~~\na\n```\nb\n~~~"), [{ code: true, lang: "", text: "a\n```\nb" }]);
});

test("缩进的围栏（列表里的代码块）照样认；Windows 换行也行", () => {
  assert.deepEqual(splitFenced("- 步骤\r\n    ```sh\r\n    ls\r\n    ```\r\n- 下一步"), [
    { code: false, text: "- 步骤" },
    { code: true, lang: "sh", text: "    ls" },
    { code: false, text: "- 下一步" },
  ]);
});

test("围栏之间只剩空白时不产生空的文本段", () => {
  assert.deepEqual(splitFenced("```a\n1\n```\n\n```b\n2\n```"), [
    { code: true, lang: "a", text: "1" },
    { code: true, lang: "b", text: "2" },
  ]);
});
