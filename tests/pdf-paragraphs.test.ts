import assert from "node:assert/strict";
import test from "node:test";
import {
  documentParagraphs,
  groupLines,
  isFrontMatter,
  isReferenceHeading,
  joinLines,
  pageParagraphs,
  paragraphKey,
  textHash,
  type PdfParagraph,
  type PdfTextItem,
} from "../src/pdf-paragraphs.ts";

const W = 600;
const H = 800;
/** 一行字：x 起点、基线 y、字高 h、行宽 w */
function line(str: string, x: number, y: number, opts: { h?: number; w?: number; eol?: boolean } = {}): PdfTextItem {
  const h = opts.h ?? 10;
  return { str, x, y, w: opts.w ?? 250, h, eol: opts.eol ?? true };
}
const texts = (items: PdfTextItem[]) => pageParagraphs(items, W, H, 1).map((p) => [p.kind, p.text]);

test("groupLines：同一基线并成一行，上下标算同一行，旋转的字丢掉", () => {
  const lines = groupLines([
    { str: "MoS", x: 50, y: 100, w: 20, h: 10, eol: false },
    { str: "2", x: 70, y: 102, w: 5, h: 6, eol: false },
    { str: " edges", x: 75, y: 100, w: 30, h: 10, eol: true },
    { str: "Downloaded from", x: 590, y: 300, w: 10, h: 8, eol: true, upright: false },
    { str: "next line", x: 50, y: 112, w: 40, h: 10, eol: true },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.h]),
    [
      ["MoS2 edges", 10],
      ["next line", 10],
    ],
  );
});

test("joinLines：行尾断词接回、复合词连字符保留、中文不加空格", () => {
  assert.equal(joinLines(["the cata-", "lyst is", "Co-", "B based"]), "the catalyst is Co-B based");
  assert.equal(joinLines(["析氢反应的", "活性位点"]), "析氢反应的活性位点");
});

test("pageParagraphs：空行、首行缩进、句末带引用号都断段；页眉页脚不进", () => {
  const items = [
    line("Journal of Things 2025", 50, 30, { eol: true }),
    line("First paragraph starts here and runs", 50, 100),
    line("to the end of the sentence.5−7", 50, 112, { w: 150 }),
    line("Second paragraph is indented by an em", 60, 124, { w: 240 }),
    line("and continues normally on this line.", 50, 136),
    line("Third after a blank line, long enough.", 50, 170),
    line("12", 300, 780),
  ];
  assert.deepEqual(texts(items), [
    ["body", "First paragraph starts here and runs to the end of the sentence.5−7"],
    ["body", "Second paragraph is indented by an em and continues normally on this line."],
    ["body", "Third after a blank line, long enough."],
  ]);
});

test("pageParagraphs：换栏续写同一句接成一段（两块外框），大写开头另起", () => {
  const ps = pageParagraphs(
    [
      line("Left column sentence that keeps going", 50, 700),
      line("into the next column (x = 0.1−", 50, 712),
      line("0.3) series and then ends here.", 320, 100, { w: 150 }),
      line("New paragraph in the right column here.", 320, 112),
    ],
    W,
    H,
    3,
  );
  assert.equal(ps.length, 2);
  assert.equal(ps[0].text, "Left column sentence that keeps going into the next column (x = 0.1− 0.3) series and then ends here.");
  assert.equal(ps[0].boxes.length, 2);
  assert.equal(ps[0].id, "3:0");
  assert.equal(ps[1].text, "New paragraph in the right column here.");
});

test("pageParagraphs：大字号是标题；首行放大但句子没完的接着正文；图里的小字是碎片", () => {
  assert.deepEqual(
    texts([
      line("1 INTRODUCTION", 50, 100, { h: 14, w: 120 }),
      line("Electrochemical water splitting via the", 50, 120, { h: 12 }),
      line("hydrogen evolution reaction is promising.", 50, 132),
      line("Latency [ms]", 400, 300, { h: 7, w: 40 }),
      line("0.1", 400, 320, { h: 7, w: 10 }),
    ]),
    [
      ["heading", "1 INTRODUCTION"],
      ["body", "Electrochemical water splitting via the hydrogen evolution reaction is promising."],
      ["fragment", "Latency [ms]"],
      ["fragment", "0.1"],
    ],
  );
});

test("段落哈希：空白不同算同一段，内容不同不同", () => {
  assert.equal(paragraphKey("a  b\nc"), paragraphKey("a b c"));
  assert.notEqual(textHash("a b c"), textHash("a b d"));
  assert.deepEqual(pageParagraphs([], 0, 0, 1), []);
});

test("isFrontMatter：作者单位、通讯作者、邮箱、期刊页眉、收稿日期、版权算题录；摘要正文不算", () => {
  for (const t of [
    "Zhengbing Fu a, Wei Wang a,c, Jianping Dong c, Bin Xiao b,c,*, Feng Wang a,** a School of Chemistry and Materials Science, Hubei Engineering University, Xiaogan, Hubei, 432100, China",
    "* Corresponding author at: School of Resources and Environmental Engineering, Gannan College of Science and Technology.",
    "E-mail addresses: 9320220063@gnust.edu.cn (B. Xiao).",
    "Contents lists available at ScienceDirect",
    "Colloids and Surfaces A journal homepage: www.elsevier.com/locate/colsurfa",
    "https://doi.org/10.1016/j.colsurfa.2026.142028 Received 31 July 2026; Accepted 6 October 2026",
    "0927-7757/© 2026 Elsevier B.V. All rights are reserved.",
    "Justus Masa,* Philipp Weide, Daniel Peeters, Ilya Sinev, Wei Xia, and Wolfgang Schuhmann*",
    "Dr. J. Masa, Dr. Z. Sun, Prof. W. Schuhmann Analytical Chemistry – Center for Electrochemical Sciences (CES)",
    "Cite This: ACS Energy Lett. 2025, 10, 4560−4566 Read Online",
    "ACCESS Metrics & More Article Recommendations",
  ]) {
    assert.equal(isFrontMatter(t, 1), true, t);
  }
  const abstract =
    "Developing cost-effective and highly active bifunctional electrocatalysts through sustainable synthetic strategies is essential for efficient alkaline water-splitting. Herein, NiFe borides were prepared by Joule heating at the University lab.";
  assert.equal(isFrontMatter(abstract, 1), false);
  assert.equal(isFrontMatter("Biomass-derived carbon, NiFe boride, Joule heating, School of thought, electrocatalyst", 3), false, "单位块只认第 1 页");
});

test("isReferenceHeading：单独一行或直接跟第一条；正文里提到 References 不算", () => {
  assert.equal(isReferenceHeading("References"), true);
  assert.equal(isReferenceHeading("■ REFERENCES"), true);
  assert.equal(isReferenceHeading("References [1] X. Wang, Y. Li, Nature 1 (2020) 1."), true);
  assert.equal(isReferenceHeading("REFERENCES (1) Turner, J. A. Science 2004, 305, 972."), true);
  assert.equal(isReferenceHeading("REFER ENCES 1. Dresselhaus, MS, Thomas IL. Alternative energy."), true, "字距拉开");
  assert.equal(isReferenceHeading("References in the literature disagree on this point."), false);
});

test("没有 References 标题（Wiley / RSC / ACS）：连着两段像参考文献才算开始", () => {
  for (const [a, b] of [
    ["[1] a) T. V. Vineesh, M. P. Kumar, Adv. Energy Mater. 2015, 5, 1402033.", "[2] J. Ren, Adv. Energy Mater. 2015, 5, 1401660."],
    ["1 S. Sharma and S. K. Ghoshal, Renewable Sustainable Energy Rev., 2015, 43, 1151–1158.", "2 J. Chi and H. Yu, Chin. J. Catal., 2018, 39, 390–394."],
    ["(1) Edwards, P. P.; Kuznetsov, V. L. Proc. R. Soc. 2007, 463, 1.", "(2) Turner, J. A. Science 2004, 305, 972."],
  ]) {
    const raw = new Map<number, PdfParagraph[]>([
      [1, [p(1, 0, "Body text here, finished.")]],
      [2, [p(2, 0, "Acknowledgements go here."), p(2, 1, a), p(2, 2, "0.1", "fragment"), p(2, 3, b)]],
    ]);
    assert.deepEqual(documentParagraphs(raw, 2).get(2)!.map((q) => q.kind), ["body", "reference", "reference", "reference"], a);
  }
  // 单独一行的「REFERENCES」是碎片也认；Angewandte 一条拆成几行、[1] 那行没年份也带上
  const ang = new Map<number, PdfParagraph[]>([
    [1, [p(1, 0, "Body.")]],
    [2, [p(2, 0, "Thanks."), p(2, 1, "[1] a) J. A. Turner, b) G. Walter, E. L."), p(2, 2, "Warren, Chem. Rev. 2010, 110, 6446."), p(2, 3, "[2] a) L. Ham, Acc. Chem. Res. 2009, 42, 1."), p(2, 4, "Am. Chem. Soc."), p(2, 5, "[3] B. Li, Science 2010, 3, 4.")]],
  ]);
  assert.deepEqual(documentParagraphs(ang, 2).get(2)!.map((q) => q.kind), ["body", "reference", "reference", "reference", "reference", "reference"]);
  const frag = new Map<number, PdfParagraph[]>([[2, [p(2, 0, "Thanks."), p(2, 1, "REFERENCES", "fragment"), p(2, 2, "(1) Masson-Delmotte, V. IPCC 2018.")]]]);
  assert.deepEqual(documentParagraphs(frag, 2).get(2)!.map((q) => q.kind), ["body", "reference", "reference"]);
  // 正文里单独一段「2 M KOH…」不算
  const lone = new Map<number, PdfParagraph[]>([[2, [p(2, 0, "2 M KOH was used in 2019 tests."), p(2, 1, "More body.")]]]);
  assert.deepEqual(documentParagraphs(lone, 2).get(2)!.map((q) => q.kind), ["body", "body"]);
});

test("作者信息小节到下一个标题整块是题录（图注除外）；跨页非大写开头也接；编号小节标题认成标题", () => {
  const raw = new Map<number, PdfParagraph[]>([
    [1, [p(1, 0, "lies at ΔGH"), p(1, 1, "■ AUTHOR INFORMATION", "heading"), p(1, 2, "Authors Eunsoo Lee − Department of Chemistry"), p(1, 3, "Figure 8. A caption."), p(1, 4, "■ ACKNOWLEDGMENTS", "heading"), p(1, 5, "We thank the lab, and it ended at")]],
    [2, [p(2, 0, "(−0.25 to −0.12 eV) lies between these.")]],
  ]);
  const doc = documentParagraphs(raw, 2);
  assert.deepEqual(doc.get(1)!.map((q) => q.kind), ["body", "meta", "meta", "body", "heading", "body"]);
  assert.equal(doc.get(2)![0].kind, "continued");
  assert.equal(doc.get(2)![0].of, "1:5");
  assert.deepEqual(texts([line("3.2. Electrocatalytic activity analysis", 50, 100, { w: 200 }), line("The test was run in KOH and it worked well.", 50, 130)]), [
    ["heading", "3.2. Electrocatalytic activity analysis"],
    ["body", "The test was run in KOH and it worked well."],
  ]);
});

function p(page: number, i: number, text: string, kind: PdfParagraph["kind"] = "body"): PdfParagraph {
  return { id: `${page}:${i}`, page, text, kind, hash: `h${page}${i}`, boxes: [{ x: 0.1, y: 0.1 * (i + 1), w: 0.4, h: 0.05 }] };
}

test("documentParagraphs：题录记 meta、参考文献起往后记 reference、跨页没写完的段并进上一页", () => {
  const raw = new Map<number, PdfParagraph[]>([
    [1, [p(1, 0, "A Title Here", "heading"), p(1, 1, "Developing catalysts is essential. It exhibits excellent activity in"), p(1, 2, "* Corresponding author.")]],
    [2, [p(2, 0, "Fig. 1. Something shown here."), p(2, 1, "current densities of 10 mA. Done."), p(2, 2, "Results look good and keep going")]],
    [3, [p(3, 0, "Another Capital start, not a continuation."), p(3, 1, "References"), p(3, 2, "[1] A. Author, J. Chem. 1 (2020) 1.")]],
    [4, [p(4, 0, "[2] B. Author, J. Chem. 2 (2021) 2.")]],
  ]);
  const doc = documentParagraphs(raw, 4);
  const kinds = (n: number) => doc.get(n)!.map((q) => q.kind);
  assert.deepEqual(kinds(1), ["heading", "body", "meta"]);
  assert.equal(doc.get(1)![1].text, "Developing catalysts is essential. It exhibits excellent activity in current densities of 10 mA. Done.");
  assert.deepEqual(doc.get(1)![1].tail?.map((t) => t.page), [2]);
  assert.deepEqual(kinds(2), ["body", "continued", "body"]);
  assert.equal(doc.get(2)![1].of, "1:1");
  assert.notEqual(doc.get(1)![1].hash, "h11", "并段后哈希跟着新原文");
  assert.deepEqual(kinds(3), ["body", "reference", "reference"], "大写开头不接；参考文献标题起往后");
  assert.deepEqual(kinds(4), ["reference"]);
  assert.equal(raw.get(1)![1].kind, "body", "不改输入");
  assert.equal(raw.get(2)![1].kind, "body");
  // 前 40% 的页里出现 References 不算参考文献开始
  assert.deepEqual(documentParagraphs(new Map([[1, [p(1, 0, "References")]]]), 10).get(1)!.map((q) => q.kind), ["body"]);
});
