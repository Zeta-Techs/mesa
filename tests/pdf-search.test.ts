import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSearchStream,
  findAllInStream,
  flattenPdfOutline,
  locateFigure,
  matchSegments,
  mergeLineRects,
  normalizeSearchQuery,
  pageSearchLines,
  pageSearchText,
  pdfDestTop,
  quoteSearchCandidates,
} from "../src/pdf-search.ts";

test("页文本组装：项间不补空格、行尾补一个空格、行尾断词复原", () => {
  const s = buildSearchStream([
    { text: "The electro-", eol: true },
    { text: "chemical", eol: false },
    { text: " window", eol: true },
    { text: "is wide.", eol: false },
  ]);
  assert.equal(s.text, "the electrochemical window is wide.");
  // 每个字符都记得来源；行尾补的空格不属于任何文本项
  const sp = s.text.indexOf(" is");
  assert.equal(s.piece[sp], -1);
});

test("归一：大小写、弯引号、各式短横线、连字、不可见字符", () => {
  assert.equal(normalizeSearchQuery("Mg–S  Batteries’"), "mg-s batteries'");
  assert.equal(normalizeSearchQuery("\uFB01eld\u00ADwork"), "fieldwork");
  // 范围号跨行不并字
  assert.equal(normalizeSearchQuery("pages 3–\n5"), "pages 3- 5");
  // 选段跨行的断词同页文本一样复原
  assert.equal(normalizeSearchQuery("electro-\nchemical"), "electrochemical");
});

test("命中落到文本项上的分段：跨项拆段，行尾空格跳过", () => {
  const s = buildSearchStream([
    { text: "solid elec", eol: false },
    { text: "trolyte", eol: true },
    { text: "interphase", eol: false },
  ]);
  const q = normalizeSearchQuery("electrolyte interphase");
  const hits = findAllInStream(s, q);
  assert.deepEqual(hits, [6]);
  assert.deepEqual(matchSegments(s, hits[0], q.length), [
    { piece: 0, from: 6, to: 10 },
    { piece: 1, from: 0, to: 7 },
    { piece: 2, from: 0, to: 10 },
  ]);
});

test("findAllInStream：不重叠、空查询无命中", () => {
  const s = buildSearchStream([{ text: "aaaa", eol: false }]);
  assert.deepEqual(findAllInStream(s, "aa"), [0, 2]);
  assert.deepEqual(findAllInStream(s, ""), []);
});

test("同一行的碎矩形合并，不同行分开", () => {
  const merged = mergeLineRects([
    { x: 10, y: 100, w: 40, h: 12 },
    { x: 10, y: 99, w: 40, h: 14 }, // WebKit 同片的第二个盒
    { x: 52, y: 100, w: 30, h: 12 }, // 相邻片
    { x: 10, y: 120, w: 50, h: 12 }, // 下一行
    { x: 0, y: 0, w: 0, h: 5 }, // 空盒丢掉
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { x: 10, y: 99, w: 72, h: 14 });
  assert.deepEqual(merged[1], { x: 10, y: 120, w: 50, h: 12 });
});

test("pageSearchText / pageSearchLines 直接吃 getTextContent 的文本项", () => {
  const items = [
    { str: "Fig. 2. Cycling", hasEOL: false },
    { str: " performance", hasEOL: true },
    { str: "", hasEOL: true },
    { str: "as shown in Fig. 3", hasEOL: true },
    { hasEOL: false }, // 标记内容项没有 str
  ];
  assert.equal(pageSearchText(items), "fig. 2. cycling performance as shown in fig. 3 ");
  assert.deepEqual(pageSearchLines(items), [
    "fig. 2. cycling performance",
    "as shown in fig. 3",
  ]);
});

test("图表定位：图注（行首）优先于正文里的提及，子图按主编号", () => {
  const pages = [
    ["introduction", "as shown in fig. 2, the cell"],
    ["fig. 1. schematic", "table 1 | electrolyte list"],
    ["fig. 2. cycling performance of mg-s cells at 0.1 c"],
  ];
  assert.deepEqual(locateFigure(pages, "figure", "2b"), {
    page: 3,
    quote: "fig. 2. cycling performance of mg-s cells at 0.1 c",
  });
  assert.deepEqual(locateFigure(pages, "table", "1"), {
    page: 2,
    quote: "table 1 | electrolyte list",
  });
  // 没有图注时退到第一次被提到的页
  assert.deepEqual(locateFigure([["see figure 4 for details"]], "figure", "4"), {
    page: 1,
    quote: "figure 4",
  });
  // 「Fig. 21」不是「Fig. 2」
  assert.equal(locateFigure([["fig. 21. other"]], "figure", "2"), null);
  assert.equal(locateFigure(pages, "figure", "9"), null);
});

test("目录拍平：限层数、跳空标题与无落点项", () => {
  const flat = flattenPdfOutline(
    [
      {
        title: " 1  Introduction ",
        dest: "d1",
        items: [{ title: "1.1 Background", dest: [1], items: [{ title: "deep", dest: "x", items: [{ title: "too deep", dest: "y" }] }] }],
      },
      { title: "", dest: "d2" },
      { title: "No dest", dest: null },
    ],
    3,
  );
  assert.deepEqual(
    flat.map((e) => [e.title, e.depth]),
    [
      ["1 Introduction", 0],
      ["1.1 Background", 1],
      ["deep", 2],
    ],
  );
  assert.deepEqual(flattenPdfOutline(null), []);
});

test("目录落点高度：XYZ/FitH/FitR 有高度，Fit 没有", () => {
  assert.equal(pdfDestTop([{}, { name: "XYZ" }, 0, 700, null]), 700);
  assert.equal(pdfDestTop([{}, { name: "FitH" }, 512]), 512);
  assert.equal(pdfDestTop([{}, { name: "FitR" }, 0, 0, 100, 640]), 640);
  assert.equal(pdfDestTop([{}, { name: "Fit" }]), null);
  assert.equal(pdfDestTop([{}, { name: "XYZ" }, 0, null, null]), null);
});

test("标注重定位候选：原样 → 去词内连字符 → 前 60 字；查找只用原样", () => {
  const page = buildSearchStream([
    { text: "prepared in an argon-", eol: true },
    { text: "filled glovebox", eol: false },
  ]);
  const cands = quoteSearchCandidates("prepared in an argon-filled glovebox");
  assert.deepEqual(cands, [
    "prepared in an argon-filled glovebox",
    "prepared in an argonfilled glovebox",
  ]);
  assert.equal(findAllInStream(page, cands[0]).length, 0);
  assert.equal(findAllInStream(page, cands[1]).length, 1);
  assert.deepEqual(quoteSearchCandidates("Mg-S cell", true), ["mg-s cell"]);
  const long = "a".repeat(70);
  assert.deepEqual(quoteSearchCandidates(long), [long, "a".repeat(60)]);
  assert.deepEqual(quoteSearchCandidates("   "), []);
});
