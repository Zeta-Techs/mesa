import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterNoticeGroups,
  noticeDepCount,
  parseNotices,
} from "../src/third-party-notices.ts";

const SAMPLE = [
  "# Mesa 第三方开源许可清单",
  "",
  "本文件由 `npm run gen:notices` 生成，请勿手改。",
  "",
  "## 内嵌资产",
  "",
  "### 字体（OFL 1.1）",
  "",
  "```",
  "## 这一行在代码块里，不是节标题",
  "```",
  "",
  "## 前端依赖（npm，随安装包分发）",
  "",
  "| 组件 | 版本 | 许可 |",
  "|---|---|---|",
  "| react | 19.1.0 | MIT |",
  "| dompurify | 3.2.0 | MPL-2.0 OR Apache-2.0 |",
  "",
  "## 设计参考致谢",
  "",
  "- cc-switch",
  "",
  "## Rust 依赖（静态链接进安装包）",
  "",
  "| 组件 | 版本 | 许可 |",
  "|---|---|---|",
  "| tauri | 2.5.0 | Apache-2.0 OR MIT |",
].join("\n");

test("依赖表拆成组与行，括注进 note；生成说明不展示；代码块里的 ## 不当节标题", () => {
  const p = parseNotices(SAMPLE);
  assert.deepEqual(
    p.groups.map((g) => [g.title, g.note, g.deps.length]),
    [
      ["前端依赖", "npm，随安装包分发", 2],
      ["Rust 依赖", "静态链接进安装包", 1],
    ],
  );
  assert.deepEqual(p.groups[0].deps[1], {
    name: "dompurify",
    version: "3.2.0",
    license: "MPL-2.0 OR Apache-2.0",
  });
  assert.ok(p.prose.startsWith("## 内嵌资产"));
  assert.ok(p.prose.includes("## 设计参考致谢"));
  assert.ok(p.prose.includes("这一行在代码块里"), "代码块内容留在所属节");
  assert.ok(!p.prose.includes("请勿手改"), "文件头是写给维护者的");
  assert.ok(!p.prose.includes("| react"), "依赖表不混进说明");
  assert.equal(noticeDepCount(p.groups), 3);
});

test("搜索：名字或许可、不分大小写；搜空的组不留；空查询原样", () => {
  const { groups } = parseNotices(SAMPLE);
  assert.equal(filterNoticeGroups(groups, "  ").length, 2);
  const mpl = filterNoticeGroups(groups, "mpl");
  assert.deepEqual(mpl.map((g) => g.deps.map((d) => d.name)), [["dompurify"]]);
  const tauri = filterNoticeGroups(groups, "TAURI");
  assert.deepEqual(tauri.map((g) => g.title), ["Rust 依赖"]);
  assert.equal(filterNoticeGroups(groups, "不存在的组件").length, 0);
});

test("随包清单真文件能解析出两张非空依赖表（gen:notices 格式变了这里先红）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const md = readFileSync(join(here, "../src-tauri/resources/third-party-notices.md"), "utf8");
  const p = parseNotices(md);
  assert.equal(p.groups.length, 2);
  for (const g of p.groups) assert.ok(g.deps.length > 50, `${g.title} 行数异常`);
  assert.ok(p.prose.includes("## 数据来源"));
});
