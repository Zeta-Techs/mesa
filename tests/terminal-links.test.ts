import assert from "node:assert/strict";
import test from "node:test";
import {
  hitCellRange,
  terminalPathHit,
  terminalPathHits,
} from "../src/terminal-links.ts";

test("绝对路径和行号能点开", () => {
  const hit = terminalPathHit("see /Users/a/src/main.ts:40 next");
  assert.equal(hit?.path, "/Users/a/src/main.ts");
  assert.equal(hit?.kind, "absolute");
  assert.equal(hit?.line, 40);
  const win = terminalPathHit(String.raw`C:\proj\a.rs:12`);
  assert.equal(win?.path, String.raw`C:\proj\a.rs`);
  assert.equal(win?.line, 12);
});

test("相对路径带行号或扩展名算候选（点击时校验存在），网址与普通词不算", () => {
  const rel = terminalPathHit("产物在 output/figures/fig1.pdf 里");
  assert.equal(rel?.path, "output/figures/fig1.pdf");
  assert.equal(rel?.kind, "relative");
  const withLine = terminalPathHit("error: src/main.rs:40:3 无法编译");
  assert.equal(withLine?.path, "src/main.rs");
  assert.equal(withLine?.line, 40);
  assert.equal(withLine?.kind, "relative");
  const home = terminalPathHit("见 ~/notes/idea.md");
  assert.equal(home?.path, "~/notes/idea.md");
  assert.equal(home?.kind, "relative");
  const dotSlash = terminalPathHit("改 ./scripts/run.py");
  assert.equal(dotSlash?.path, "./scripts/run.py");
  // 网址、无扩展的普通词（and/or）不是候选
  assert.equal(terminalPathHit("https://example.com/a"), null);
  assert.equal(terminalPathHit("either and/or maybe"), null);
  assert.equal(terminalPathHit("普通一段话没有路径"), null);
});

test("行列号（rust/clang 风格）与句尾标点", () => {
  const both = terminalPathHit("error at src 入口 /a/b/src/main.rs:339:12:");
  assert.equal(both?.path, "/a/b/src/main.rs");
  assert.equal(both?.line, 339);
  // 句尾句点/逗号/全角标点不吞进路径
  const dot = terminalPathHit("文件在 /Users/a/b.md.");
  assert.equal(dot?.path, "/Users/a/b.md");
  const zh = terminalPathHit("改一下 /Users/a/配置.toml，如下");
  assert.equal(zh?.path, "/Users/a/配置.toml");
  // 冒号后的行号丢了边界时不得把后续文字并进路径
  const glued = terminalPathHit("打开 /Users/a/b.rs:42：第 42 行");
  assert.equal(glued?.path, "/Users/a/b.rs");
  assert.equal(glued?.line, 42);
});

test("行首是边界字符（空格/引号/;/全角标点）不挂死，路径照常命中", () => {
  // 2026-10-11 P0 回归锚：零宽匹配曾让这些行死循环冻结 UI；
  // lookbehind 前缀修复后，行首单个边界字符后紧跟的路径也该命中
  const indented = terminalPathHits("    indented src/main.rs:40 here");
  assert.equal(indented[0]?.path, "src/main.rs");
  assert.equal(indented[0]?.line, 40);
  assert.equal(terminalPathHits("; starts with semicolon").length, 0);
  const colon = terminalPathHit("：/abs/p.rs:1：");
  assert.equal(colon?.path, "/abs/p.rs");
  assert.equal(colon?.line, 1);
  assert.equal(terminalPathHit(" /abs/a.rs:9")?.path, "/abs/a.rs");
  assert.equal(terminalPathHits('"quoted src/a.rs:9"')[0]?.path, "src/a.rs");
  assert.deepEqual(terminalPathHits(""), []);
});

test("中文弯引号与全角冒号边界（中文输出高频形态）", () => {
  const q1 = terminalPathHit("错误在“src/a.rs:40”");
  assert.equal(q1?.path, "src/a.rs");
  assert.equal(q1?.line, 40);
  assert.ok(q1 && q1.start >= 3, "前文不得吞进候选");
  const q2 = terminalPathHit("他说“看 src/a.rs:40”结尾");
  assert.equal(q2?.line, 40);
  const colon = terminalPathHit("路径是：/abs/a/b.md");
  assert.equal(colon?.path, "/abs/a/b.md");
  assert.equal(colon?.kind, "absolute");
});

test("hitCellRange 把字符下标换算成 1 起的单元格列号", () => {
  const hits = terminalPathHits("文件 /Users/a/b.rs:40 在这");
  const hit = hits[0]!;
  assert.equal(hit.start, 3);
  assert.equal(hit.end, 19);
  // 「文件」两个汉字各占 2 格（搭子格不产字符）：字符 0→格0、1→格2、2→格4、3→格5…
  // columns 即链接提供方逐格自算的「字符→列号」映射
  const columns = [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24];
  const range = hitCellRange(hit, columns);
  // 路径起点是 0 起第 5 格（1 起 x=6），行号末字符在 0 起第 20 格（1 起 x=21）
  assert.equal(range?.startX, 6);
  assert.equal(range?.endX, 21);
  assert.equal(hitCellRange(hit, []), null);
});
