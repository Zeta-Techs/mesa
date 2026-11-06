import assert from "node:assert/strict";
import test from "node:test";
import { buildDeskItems, deskSummary, looksLikeQuestion, questionExcerpt, relayText } from "../src/assistant-queue.ts";

const steps = [
  { index: 0, name: "检索", workspaceName: "lit-search", worktreePath: "/w/lit" },
  { index: 1, name: "分析", workspaceName: "analysis", worktreePath: "/w/ana" },
  { index: 2, name: "作图", workspaceName: "figs", worktreePath: "/w/figs" },
];

test("像在问人：问号结尾或「要不要 / 是否 / 请确认」；总结不算", () => {
  assert.equal(looksLikeQuestion("两孔异常，要剔除吗？"), true);
  assert.equal(looksLikeQuestion("我可以先按保留算。你希望用哪种口径"), true);
  assert.equal(looksLikeQuestion("已完成，图在 figures/ 下。"), false);
  assert.equal(looksLikeQuestion(""), false);
  assert.match(questionExcerpt("a".repeat(500) + "。最后：要不要剔除？", 40), /^…/);
});

test("等你的事：人工请求、等确认、对话里在问；同一步有人工请求时不重复说对话里的问题；在干活的不算", () => {
  const items = buildDeskItems({
    steps,
    help: [
      {
        root: "/w/ana",
        workspaceName: "analysis",
        items: [
          { id: "h1", question: "两孔保留还是剔除？", detail: [], recommend: "B", options: [{ key: "A", label: "保留", effect: null }, { key: "B", label: "剔除", effect: "均值变化" }], answer: null, sent: null },
          { id: "h2", question: "已答的", detail: [], recommend: null, options: [], answer: "A", sent: null },
        ],
      },
    ],
    tails: [
      { step: steps[1], text: "要不要剔除？", busy: false },
      { step: steps[2], text: "配色用灰度还是彩色？", busy: false },
      { step: steps[0], text: "检索词要不要加 MeSH？", busy: true },
    ],
    confirms: [{ tabId: "t9", title: "作图", step: null }],
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.step, i.where]),
    [
      ["help", 2, "第 2 步「分析」"],
      ["confirm", null, "对话「作图」"],
      ["question", 3, "第 3 步「作图」"],
    ],
  );
  assert.equal(items[0].helpItemId, "h1");
  assert.equal(items[0].worktreePath, "/w/ana");
  assert.equal(deskSummary(items), "等你的事 3 件：人工请求 1 · 对话里在问 1 · 等确认 1");
  assert.equal(deskSummary([]), "");
});

test("转达是原话，只加一行来源", () => {
  assert.equal(relayText("  剔除那两孔  "), "【你在项目助手里的回复，Mesa 原话转达】\n剔除那两孔");
});

test("信任文件夹：单列一类，带两项原文与是否你派的活；同一步不再列对话里的问题", () => {
  const items = buildDeskItems({
    steps,
    help: [],
    tails: [{ step: steps[2], text: "要不要继续？", busy: false }],
    confirms: [{ tabId: "t1", title: "周报", step: steps[2], trust: { yes: "Yes, I trust this folder", no: "No, exit", path: "/iso/x", dispatched: true } }],
  });
  assert.deepEqual(items.map((i) => [i.kind, i.key]), [["trust", "trust:t1"]]);
  assert.match(items[0].question, /是否信任这个文件夹」（\/iso\/x）/);
  assert.equal(items[0].trust?.dispatched, true);
  assert.equal(deskSummary(items), "等你的事 1 件：等信任文件夹 1");
});
