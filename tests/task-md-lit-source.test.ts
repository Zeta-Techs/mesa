import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDiscussSections,
  litSourceSectionLines,
  syncDynamicTaskSections,
  upsertLitSourceSection,
  upsertPendingSettingsSection,
} from "../src/task-md-sections.ts";
import { parseDecisions, upsertDecisions } from "../src/step-decisions.ts";

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
    assert.match(s, /先盘库/);
    assert.match(s, /不回溯剔除人工导入条目/);
    assert.match(s, /库内已有 \+ 缺口粗检候选/);
  }
  // 非检索步骤（精读/大纲/初稿等）不注入检索盘库细则，只给简洁只读背景并声明本步只交预期产物
  const notesZotero = litSourceSectionLines("zotero", "lit-notes")!.join("\n");
  assert.match(notesZotero, /Zotero 库/);
  assert.match(notesZotero, /本步只交付下方「预期产物」/);
  assert.doesNotMatch(notesZotero, /先盘库/);
  assert.match(litSourceSectionLines("zotero", "lit-search")!.join("\n"), /先盘库/);
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

test("ensureDiscussSections：商量播种时预置空的「已定方向 / 待拍板」，已有不覆盖且不污染决策解析", () => {
  const assembled = [
    "# 文献检索与筛选",
    "",
    "## 文献来源",
    "来自 Zotero 库。",
    "",
    "## 决策暂停策略",
    "策略正文",
    "",
    "简报正文",
    "",
    "## 预期产物",
    "- papers/screening.md",
    "",
  ].join("\n");
  const seeded = ensureDiscussSections(assembled);
  assert.ok(seeded.indexOf("## 文献来源") < seeded.indexOf("## 已定方向"), seeded);
  assert.ok(seeded.indexOf("## 已定方向") < seeded.indexOf("## 本步补充要求"), seeded);
  assert.ok(seeded.indexOf("## 本步补充要求") < seeded.indexOf("## 决策暂停策略"), seeded);
  assert.ok(seeded.indexOf("简报正文") < seeded.indexOf("## 待拍板"), seeded);
  assert.ok(seeded.indexOf("## 待拍板") < seeded.indexOf("## 预期产物"), seeded);
  assert.equal(parseDecisions(seeded).size, 0, "预置空小节不制造假决策");
  assert.equal(ensureDiscussSections(seeded), seeded, "重复调用幂等");

  const withAnswer = upsertDecisions(seeded, [{ q: "核心问题", answer: "聚焦双功能催化剂" }]);
  assert.equal(parseDecisions(withAnswer).get("核心问题"), "聚焦双功能催化剂");
  assert.equal(ensureDiscussSections(withAnswer), withAnswer, "已有内容的小节不被覆盖");
});

test("syncDynamicTaskSections：同步「本机 Python」段（带 MESA_LIT_RECORDS），同时保留已定方向", () => {
  const draft = [
    "# 文献精读与笔记",
    "",
    "## 已定方向",
    "- 保持用户手写口径",
    "",
    "## 本机 Python",
    "- 跑 Python 用 `\"$MESA_PYTHON\"`",
    "",
    "## 收尾",
    "旧收尾",
  ].join("\n");
  const assembled = [
    "# 文献精读与笔记",
    "",
    "## 本机 Python",
    "- 跑 Python 用 `\"$MESA_PYTHON\"`",
    "- 文献脚本：`lit_records.py` 完整路径已注入环境变量 `MESA_LIT_RECORDS`",
    "",
    "## 收尾",
    "新收尾",
  ].join("\n");
  const synced = syncDynamicTaskSections(draft, assembled);
  assert.match(synced, /保持用户手写口径/);
  assert.match(synced, /MESA_LIT_RECORDS/);
});

test("renderTaskMd：上游已定好文献数据抽取表列时，下游项目规则不再滞留「让 AI 提议列」", async () => {
  const { renderTaskMd } = await import("../src/task-md.ts");
  const cfg = {
    version: 1,
    topic: "硼化物析氢",
    workMode: "research" as const,
    settings: ["去向：投期刊", "文献数据抽取表：让 AI 提议列"],
    steps: [],
    resources: [],
  };
  const step = {
    name: "综述大纲",
    workspaceName: "outline",
    brief: "大纲简报",
    inputs: [],
    skills: [],
    acceptanceCriteria: [],
    expectedArtifacts: ["outline.md"],
  };
  const out = renderTaskMd(
    step as never,
    cfg as never,
    "/tmp/boride",
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    0,
    "",
    [
      {
        stepName: "文献精读与笔记",
        items: [{ q: "文献数据抽取表的列（总计 10 列）", answer: "材料；过电位；来源 [@键]；页码／图表" }],
      },
    ],
  );
  assert.match(out, /文献数据抽取表：已在上游定好列/);
  assert.doesNotMatch(out, /文献数据抽取表：让 AI 提议列/);
});
