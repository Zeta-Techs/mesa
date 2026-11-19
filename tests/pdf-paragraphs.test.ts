import assert from "node:assert/strict";
import test from "node:test";
import {
  groupLines,
  joinLines,
  pageParagraphs,
  paragraphKey,
  textHash,
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
