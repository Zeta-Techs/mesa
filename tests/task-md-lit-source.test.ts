import assert from "node:assert/strict";
import test from "node:test";
import {
  litSourceSectionLines,
  upsertLitSourceSection,
  upsertPendingSettingsSection,
} from "../src/task-md-sections.ts";

test("search/空：无「文献来源」段", () => {
  assert.equal(litSourceSectionLines("search"), null);
  assert.equal(litSourceSectionLines(""), null);
  assert.equal(litSourceSectionLines(undefined), null);
});

test("zotero/folder/endnote：段内容分版本，且不在检索步宣称首次题录见 references.bib", () => {
  const zotero = litSourceSectionLines("zotero")!.join("\n");
  const folder = litSourceSectionLines("folder")!.join("\n");
  const endnote = litSourceSectionLines("endnote")!.join("\n");
  assert.match(zotero, /Zotero 库/);
  assert.match(folder, /本地文件夹/);
  assert.match(folder, /EndNote/);
  assert.match(endnote, /不读 \.enl/);
  assert.match(endnote, /同步到 EndNote/);
  for (const s of [zotero, folder, endnote]) {
    assert.doesNotMatch(s, /首次题录见 references\.bib/);
    assert.match(s, /included\.json/);
  }
});

test("已存任务书补上还没填的全局设定，已填的不进这一节", () => {
  const text = "# 步骤\n\n## 项目规则\n\n- 去向：EES期刊\n\n## 文献来源\n\n已有库。\n";
  const out = upsertPendingSettingsSection(text, [
    "去向：EES期刊",
    "综述角度：（领域全景 / 聚焦某个子问题）",
  ]);
  assert.match(out, /## 待确认的全局设定/);
  assert.match(out, /综述角度：/);
  assert.doesNotMatch(out.split("## 待确认的全局设定")[1] ?? "", /EES期刊/);
  assert.ok(out.indexOf("## 待确认的全局设定") < out.indexOf("## 文献来源"));
  const cleared = upsertPendingSettingsSection(out, ["综述角度：聚焦某个子问题"]);
  assert.doesNotMatch(cleared, /## 待确认的全局设定/);
});

test("无段时插入：优先落在「已定方向」之前", () => {
  const text = "# 步骤\n\n## 已定方向\n\n- a：b\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "zotero");
  assert.ok(
    out.indexOf("## 文献来源") < out.indexOf("## 已定方向"),
    out,
  );
  assert.ok(out.indexOf("## 已定方向") < out.indexOf("## 预期产物"), out);
});

test("无段且无锚点：补到末尾", () => {
  const text = "# 步骤\n\n简报正文\n";
  const out = upsertLitSourceSection(text, "folder");
  assert.match(out, /简报正文\n\n## 文献来源\n/);
});

test("已有段：原位替换（zotero → folder），不伤前后小节", () => {
  const text =
    "# 步骤\n\n## 文献来源\n\n本项目的文献来自用户已有的 Zotero 库。\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "folder");
  assert.ok(!/Zotero/.test(out), out);
  assert.match(out, /本地文件夹/);
  assert.ok(out.indexOf("## 文献来源") < out.indexOf("## 预期产物"), out);
  assert.equal(out.match(/## 文献来源/g)!.length, 1);
});

test("切回 search：删除该段", () => {
  const text =
    "# 步骤\n\n## 文献来源\n\n本项目的文献来自用户已有的 Zotero 库。\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "search");
  assert.ok(!/文献来源/.test(out), out);
  assert.match(out, /## 预期产物/);
});

test("无段 + search：原样返回（调用方据此不写盘）", () => {
  const text = "# 步骤\n\n简报正文\n";
  assert.equal(upsertLitSourceSection(text, "search"), text);
});
