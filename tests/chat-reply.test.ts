import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmChoices,
  fileRefPath,
  findFileRefs,
  isProseCodeSpan,
  mentionedAudioFiles,
  mentionedImageFiles,
  REPLY_FOLD_MIN_CHARS,
  splitReplySections,
} from "../src/chat-reply.ts";

/** 把正文垫到可折长度：分节只给长回复 */
const pad = (text: string) => `${text}\n\n${"补充说明。".repeat(Math.ceil(REPLY_FOLD_MIN_CHARS / 5))}`;

test("两个以上小标题才折叠", () => {
  const sections = splitReplySections(pad("开头\n\n验收摘要：\n565 条\n\n尚未验证：\n7 篇"));
  assert.equal(sections?.length, 3);
  assert.equal(sections?.[1]?.title, "验收摘要：");
  assert.equal(splitReplySections("只有一段话"), null);
});

test("围栏代码块里的行不当小标题，代码不拆进折叠区", () => {
  const text = [
    "配置如下：",
    "",
    "```yaml",
    "server:",
    "  port: 8080",
    "db:",
    "  host: localhost",
    "```",
    "",
    "部署步骤：",
    "1. npm run build",
  ].join("\n");
  const sections = splitReplySections(pad(text));
  // 只有「配置如下：」「部署步骤：」两个真标题；YAML 键行必须留在正文里
  assert.equal(sections?.length, 2);
  assert.equal(sections?.[0]?.title, "配置如下：");
  assert.ok(sections?.[0]?.body.includes("server:"));
  assert.ok(sections?.[0]?.body.includes("```yaml"));
  assert.ok(!sections?.some((s) => s.title === "db:" || s.title === "server:"));
});

test("短回答不分节；句子里的冒号引子、列表项、加粗开头都不当小标题", () => {
  // 2026-10-17 用户截图：解释 API 的回答被折成一串空标题
  const api = [
    "# API 是什么？",
    "想象你去餐厅吃饭：",
    "- 你（顾客）想吃饭",
    "## 生活中的例子",
    "你手机上的天气 App 并不是自己测天气的。它做的事是：",
    "1. 向气象服务发请求",
  ].join("\n");
  assert.equal(splitReplySections(api), null);
  const long = splitReplySections(pad(api));
  const titles = long?.map((s) => s.title) ?? [];
  assert.ok(titles.includes("API 是什么？"));
  assert.ok(titles.includes("生活中的例子"));
  assert.ok(!titles.some((t) => t.includes("它做的事是")), "带句号的长句不是标题");
  assert.ok(!titles.some((t) => t.startsWith("-") || t.startsWith("1.")));
});

test("已经用 ## 分节的回复里，冒号句是引出下文的话，不当小标题", () => {
  // 2026-10-19 用户实测排版题：「标注语言的代码块示例如下：」被折成一节，代码块和引用收进去
  const reply = [
    "## 二、列表与代码",
    "正文一段。",
    "标注语言的代码块示例如下：",
    "",
    "```python",
    "# 注释",
    "def render(src):",
    "```",
    "引用一句：",
    "> 格式是为内容服务的",
    "## 三、公式与图片",
    "正文。",
  ].join("\n");
  const titles = splitReplySections(pad(reply))?.map((s) => s.title) ?? [];
  assert.deepEqual(titles, ["二、列表与代码", "三、公式与图片"]);
  // 没有 ## 标题的报告体（「验收摘要：」「尚未验证：」）仍按冒号行分节——见「两个以上小标题才折叠」
});

test("小标题带级别：# 数照记，冒号短行按 3 级排，引子为 0", () => {
  const sections = splitReplySections(pad("引子\n\n## 方法\n正文\n\n### 细节\n正文"))!;
  assert.deepEqual(
    sections.map((s) => [s.title, s.level]),
    [["正文", 0], ["方法", 2], ["细节", 3]],
  );
  const colon = splitReplySections(pad("验收摘要：\n565 条\n\n尚未验证：\n7 篇"))!;
  assert.equal(colon[0]?.level, 3);
});

test("文件路径：相对 / 绝对 / ~/ / 行号都认，网址、无扩展名、音频、数字不认", () => {
  assert.equal(fileRefPath("src/chat-reply.ts:42"), "src/chat-reply.ts");
  assert.equal(fileRefPath("./scripts/run.py"), "scripts/run.py");
  assert.equal(fileRefPath("README.md"), "README.md");
  assert.equal(fileRefPath("~/notes/a.md"), "~/notes/a.md");
  assert.equal(fileRefPath("src\\win\\a.tsx"), "src\\win\\a.tsx");
  for (const no of ["https://a.com/b.md", "src/lib", "and/or", "1/2.5", "v1.2", "voice/a.mp3", "a b.md", ""]) {
    assert.equal(fileRefPath(no), null, no);
  }
});

test("正文里的文件路径：只认带目录的，剥掉句读与加粗，位置对得上原文", () => {
  const text = "见 **papers/screening.md**，和 ./scripts/run.py:12。README.md 单个文件名不算；https://a.com/b.md 也不算";
  const hits = findFileRefs(text);
  assert.deepEqual(hits.map((h) => h.path), ["papers/screening.md", "scripts/run.py"]);
  for (const h of hits) assert.equal(text.slice(h.index, h.index + h.raw.length), h.raw);
  assert.equal(hits[1]?.raw, "./scripts/run.py:12");
});

test("登录确认不提供批准按钮", () => {
  assert.equal(confirmChoices("需要登录").length, 0);
  assert.equal(confirmChoices("permission to use Bash")[0]?.key, "y");
  assert.equal(confirmChoices("select a model")[0]?.key, undefined);
  // 「选择」不再当菜单词——真 y/n 确认题含它时按钮照常给（2026-10-11 修误伤）
  assert.equal(confirmChoices("选择是否继续？[y/n]")[0]?.key, "y");
});

test("回复里提到的本机音频给播放条：相对 / 绝对 / ~/ 都认，网址不认，音频不再出文件小标签", () => {
  const text = [
    "已把读音存成 `mesa_probe/mesa.aiff`，西语版在 /Users/me/ccode/scratch/mesa-es.m4a。",
    "也可以听 ~/Music/mesa.mp3，或在线版 https://example.com/mesa.mp3",
    "Markdown 写法：[英语读音](mesa_probe/mesa.aiff)、**out/voice.wav**；文本 notes/demo.md 照旧。",
  ].join("\n");
  assert.deepEqual(mentionedAudioFiles(text), [
    "mesa_probe/mesa.aiff",
    "/Users/me/ccode/scratch/mesa-es.m4a",
    "~/Music/mesa.mp3",
    "out/voice.wav",
  ]);
  assert.deepEqual(findFileRefs(text).map((h) => h.path), ["notes/demo.md"]);
  assert.deepEqual(mentionedAudioFiles("没有音频的回复。say Mesa"), []);
});

test("回复里提到的本机图片给图片卡：带目录的路径才认，裸文件名、网址、![]() 内嵌的不重复列", () => {
  const text = [
    "- **文件**：`/Users/me/ccode/scratch/puppy-fishing.jpg`（2048×2048）",
    "- **描述原文**：已存到同目录 `puppy-fishing.prompt.txt`，图名 puppy-fishing.jpg",
    "另存了 figures/cover.PNG，Windows 上是 C:\\Users\\me\\out\\a.webp；~/Pictures/b.gif。",
    "在线版 https://example.com/c.png，已内嵌 ![封面](figures/inline.png)",
  ].join("\n");
  assert.deepEqual(mentionedImageFiles(text), [
    "/Users/me/ccode/scratch/puppy-fishing.jpg",
    "figures/cover.PNG",
    "C:\\Users\\me\\out\\a.webp",
    "~/Pictures/b.gif",
  ]);
  assert.deepEqual(mentionedImageFiles("没有图片的回复。"), []);
});

// 2026-10-26 用户截图：先说「已生成 `mesa_probe/red.png`」再 ![红色方块](mesa_probe/red.png)，同一张图出了两张
test("正文里提到的图已经用 ![]() 内嵌过，就不再在下面另出一张", () => {
  const text = "已生成 `mesa_probe/red.png`（64×64 纯红 PNG，仅用标准库）：\n\n![红色方块](mesa_probe/red.png)";
  assert.deepEqual(mentionedImageFiles(text), []);
  // 写法不同（./ 前缀、反斜杠、尖括号、带标题、%20）也认作同一张
  assert.deepEqual(mentionedImageFiles("见 .\\out\\ab.png\n![图](<./out/ab.png> \"标题\")"), []);
  assert.deepEqual(mentionedImageFiles("见 out/a%20b.png 与 out/c.png\n![图](out/a%20b.png)"), ["out/c.png"]);
  // 调用方给解析函数时，相对与绝对路径也对得上
  const resolve = (p: string) => (p.startsWith("C:") ? p.replace(/\\/g, "/") : `C:/proj/${p.replace(/\\/g, "/")}`);
  assert.deepEqual(mentionedImageFiles("已存到 C:\\proj\\figs\\x.png\n![x](figs/x.png)", resolve), []);
  // 内嵌的是别的图，提到的这张照常出卡
  assert.deepEqual(mentionedImageFiles("另存了 figs/y.png\n![x](figs/x.png)"), ["figs/y.png"]);
});

test("反引号里的中文说法按正文排，带代码符号的仍是代码", () => {
  for (const t of ["随手聊", "完全访问", "接着做 Ccode", "解释一个概念"]) assert.equal(isProseCodeSpan(t), true, t);
  for (const t of ["glm-5.3-flash", "+", "↑", "notes/笔记.md", "f(中文)", "key=值", "npm test"]) {
    assert.equal(isProseCodeSpan(t), false, t);
  }
});
