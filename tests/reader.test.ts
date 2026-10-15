import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_MIN_PX,
  READER_PDF_MIN_PX,
  READER_SIDE_MIN_PX,
  READER_SPLITTER_PX,
  bytesToBase64,
  buildReaderTranslatePrompt,
  captureRectToCanvasPixels,
  captureRectUsable,
  clampReaderPct,
  clampReaderTlPct,
  classifyMdHref,
  fileUrlToPath,
  mdImageAbsPath,
  escapeGlossaryCell,
  findGlossaryMatches,
  formatPdfExcerptPrompt,
  formatReaderCapturePrompt,
  groupTextLines,
  hitTestCapture,
  isParagraphBreak,
  joinParagraphLines,
  nearestLineIndex,
  nextFitScale,
  PDF_MAX_CANVAS_PIXELS,
  PDF_MAX_CANVAS_SIDE,
  PDF_SCALE_MAX,
  PDF_SCALE_MIN,
  PDF_WHEEL_ZOOM_HALVE_PX,
  clampPdfScale,
  pdfCanvasOutputScale,
  pdfZoomCap,
  pdfPinchScale,
  pdfWheelShouldZoom,
  pdfWheelZoomFactor,
  normCaptureRect,
  paragraphBounds,
  parseGlossaryTable,
  readerColumnWidths,
  readerDarkKey,
  readerPanelSlideMargin,
  readerProgressKey,
  readerReuseKey,
  relMdLinkPath,
  renderGlossaryTable,
  resolveMdPath,
  rewriteMdImageHtml,
  splitGlossaryRow,
  stripMdHrefSuffix,
  translationSavedToast,
  upsertTlEntry,
  markTlEntrySaved,
  parseBilingual,
  plainFromBilingual,
  reflowBlockText,
  READER_TL_HISTORY_MAX,
  READER_TL_PINNED_KEY,
  loadReaderTlPinned,
  saveReaderTlPinned,
  clampReaderTlBall,
  loadReaderTlBall,
  saveReaderTlBall,
  clampReaderTlCard,
  loadReaderTlCard,
  saveReaderTlCard,
  type TlHistoryEntry,
} from "../src/reader.ts";

test("nextFitScale：无效宽返回 null，亚像素变化保持原值", () => {
  assert.equal(nextFitScale(0, 800, 1), null);
  assert.equal(nextFitScale(595, 0, 1), null);
  assert.equal(nextFitScale(-1, 800, 1), null);
  // 半像素以内的 clientWidth 抖动（滚动条槽）不改 scale
  const current = 800 / 595;
  assert.equal(nextFitScale(595, 800.4, current), null);
  assert.equal(nextFitScale(595, 799.6, current), null);
  // 超过半像素才给出新值
  const jumped = nextFitScale(595, 800 - 17, current);
  assert.ok(jumped !== null);
  assert.ok(Math.abs((jumped as number) - (783 / 595)) < 1e-9);
});

test("pdfWheelShouldZoom：仅 ⌘/Ctrl 才缩放，未按修饰键留给翻页", () => {
  assert.equal(pdfWheelShouldZoom({ ctrlKey: false, metaKey: false }), false);
  assert.equal(pdfWheelShouldZoom({ ctrlKey: true, metaKey: false }), true);
  assert.equal(pdfWheelShouldZoom({ ctrlKey: false, metaKey: true }), true);
  assert.equal(pdfWheelShouldZoom({ ctrlKey: true, metaKey: true }), true);
});

test("pdfWheelZoomFactor：连续指数，HALVE_PX 缩到一半，0/非数返回 null", () => {
  assert.equal(pdfWheelZoomFactor(0), null);
  assert.equal(pdfWheelZoomFactor(Number.NaN), null);
  assert.equal(pdfWheelZoomFactor(PDF_WHEEL_ZOOM_HALVE_PX), 0.5);
  assert.equal(pdfWheelZoomFactor(-PDF_WHEEL_ZOOM_HALVE_PX), 2);
  // 小增量接近 1（pinch 单帧），不是跳档
  const fine = pdfWheelZoomFactor(4);
  assert.ok(fine !== null);
  assert.ok((fine as number) > 0.99 && (fine as number) < 1);
  const line = pdfWheelZoomFactor(1, 1);
  assert.ok(line !== null);
  assert.ok(
    Math.abs((line as number) - 2 ** -(16 / PDF_WHEEL_ZOOM_HALVE_PX)) < 1e-12,
  );
  // 单次夹到 ±HALVE_PX，10000px 最多一倍/一半
  assert.equal(pdfWheelZoomFactor(10000), 0.5);
  assert.equal(pdfWheelZoomFactor(-10000), 2);
});

test("clampPdfScale：夹到 0.25–4，坏值回落 1", () => {
  assert.equal(clampPdfScale(1), 1);
  assert.equal(clampPdfScale(0.1), PDF_SCALE_MIN);
  assert.equal(clampPdfScale(8), PDF_SCALE_MAX);
  assert.equal(clampPdfScale(Number.NaN), 1);
  assert.equal(clampPdfScale(0), 1);
  assert.equal(clampPdfScale(-2), 1);
});

test("pdfZoomCap：fit 倍率 × 倍数，夹全局范围；缺省不限", () => {
  assert.ok(Math.abs(pdfZoomCap(1.4, 1.5) - 2.1) < 1e-9);
  assert.equal(pdfZoomCap(1.4), PDF_SCALE_MAX);
  assert.equal(pdfZoomCap(3, 1.5), PDF_SCALE_MAX);
  assert.equal(pdfZoomCap(0, 1.5), PDF_SCALE_MAX);
  assert.equal(pdfZoomCap(0.1, 1.5), PDF_SCALE_MIN);
});

test("pdfPinchScale：相对手势起点，坏倍率保持起点", () => {
  assert.equal(pdfPinchScale(1, 2), 2);
  assert.equal(pdfPinchScale(1.5, 0.5), 0.75);
  assert.equal(pdfPinchScale(1, 10), PDF_SCALE_MAX);
  assert.equal(pdfPinchScale(1, 0), 1);
  assert.equal(pdfPinchScale(1, Number.NaN), 1);
  assert.equal(pdfPinchScale(Number.NaN, 2), 2);
});


test("pdfCanvasOutputScale：普通页按 dpr，超限按像素/单边收缩", () => {
  assert.deepEqual(pdfCanvasOutputScale(100, 80, 2), { sx: 2, sy: 2 });
  assert.deepEqual(pdfCanvasOutputScale(0, 80, 2), { sx: 1, sy: 1 });
  // 总像素超 4096²：边长 5000×5000 @dpr1 = 25M > 16M
  const tight = pdfCanvasOutputScale(5000, 5000, 1);
  assert.ok(tight.sx < 1 && tight.sy < 1);
  assert.ok(5000 * tight.sx * 5000 * tight.sy <= PDF_MAX_CANVAS_PIXELS + 1e-6);
  // 单边超 8192
  const side = pdfCanvasOutputScale(20000, 100, 1, 1e12, PDF_MAX_CANVAS_SIDE);
  assert.ok(20000 * side.sx <= PDF_MAX_CANVAS_SIDE + 1e-6);
});

test("clampReaderPct 坏值/非正数回落缺省", () => {
  assert.equal(clampReaderPct(Number.NaN, 22), 22);
  assert.equal(clampReaderPct(0, 28), 28);
  assert.equal(clampReaderPct(-5, 28), 28);
  assert.equal(clampReaderPct(Infinity, 22), 22);
});

test("clampReaderPct 夹到 12–40", () => {
  assert.equal(clampReaderPct(5, 22), 12);
  assert.equal(clampReaderPct(60, 22), 40);
  assert.equal(clampReaderPct(25, 22), 25);
});

test("clampReaderTlPct 坏值/非正数回落缺省", () => {
  assert.equal(clampReaderTlPct(Number.NaN, 40), 40);
  assert.equal(clampReaderTlPct(0, 40), 40);
  assert.equal(clampReaderTlPct(-5, 40), 40);
  assert.equal(clampReaderTlPct(Infinity, 40), 40);
});

test("clampReaderTlPct 夹到 12–70", () => {
  assert.equal(clampReaderTlPct(5, 40), 12);
  assert.equal(clampReaderTlPct(80, 40), 70);
  assert.equal(clampReaderTlPct(35, 40), 35);
});

test("readerColumnWidths 侧栏按百分比取整且保底 240px", () => {
  const { left, right } = readerColumnWidths(1600, 22, 28);
  assert.equal(left, 352);
  assert.equal(right, 448);
  // 窄窗下 12% 不足 240px 时保底线生效
  const narrow = readerColumnWidths(1200, 12, 12);
  assert.equal(narrow.left, READER_SIDE_MIN_PX);
  assert.equal(narrow.right, READER_SIDE_MIN_PX);
});

test("readerColumnWidths 两侧超预算时按比例压缩，PDF 保底不被压穿", () => {
  const total = 900;
  const { left, right } = readerColumnWidths(total, 40, 40);
  // 预算 = 900 - 280 = 620，两侧各 360 → 等比压缩
  assert.equal(left + right, total - READER_PDF_MIN_PX);
  assert.equal(left, right);
  assert.ok(left < 360);
});

test("readerColumnWidths 极端窄窗侧栏归零让位", () => {
  assert.deepEqual(readerColumnWidths(READER_PDF_MIN_PX, 22, 28), {
    left: 0,
    right: 0,
  });
  assert.deepEqual(readerColumnWidths(0, 22, 28), { left: 0, right: 0 });
});

test("readerPanelSlideMargin：展开归 0，收起滑出整块（栏宽 + 分隔条热区）", () => {
  assert.equal(readerPanelSlideMargin(320, true), 0);
  // 负 margin 恰好抵掉整块占位：后续栏从窗口边起步，栏体自身宽度不变
  assert.equal(
    readerPanelSlideMargin(320, false),
    -(320 + READER_SPLITTER_PX),
  );
});

test("readerReuseKey 稳定格式（退出再进找回同一标签）", () => {
  assert.equal(readerReuseKey("/Users/u/proj"), "reader:/Users/u/proj");
});

test("formatPdfExcerptPrompt 短文本原样 + 出处格式", () => {
  assert.equal(
    formatPdfExcerptPrompt("固态电解质界面稳定性的方法", 3, "a.pdf"),
    "> 「固态电解质界面稳定性的方法」（a.pdf，第 3 页）\n\n固态电解质界面稳定性的方法",
  );
  // 摘要折行：换行/连续空白压成单个空格
  assert.equal(
    formatPdfExcerptPrompt("a\nb  c", 1, "x.pdf"),
    "> 「a b c」（x.pdf，第 1 页）\n\na\nb  c",
  );
});

test("formatPdfExcerptPrompt 超长摘要 60 字截断加省略号", () => {
  const text = "字".repeat(70);
  const out = formatPdfExcerptPrompt(text, 2, "长文.pdf");
  const [head, body] = out.split("\n\n");
  assert.equal(head, `> 「${"字".repeat(60)}…」（长文.pdf，第 2 页）`);
  assert.equal(body, text);
});

test("formatPdfExcerptPrompt 正文超过 6000 字截断", () => {
  const text = "正".repeat(6001);
  const out = formatPdfExcerptPrompt(text, 1, "a.pdf");
  const body = out.split("\n\n")[1];
  assert.equal(body.length, 6001); // 6000 + 省略号
  assert.ok(body.endsWith("…"));
});

// ===== 批次 B2：圈选截图与 md 图片/链接 =====

test("normCaptureRect 任意方向拖拽归一化", () => {
  assert.deepEqual(normCaptureRect(10, 20, 30, 50), { x: 10, y: 20, w: 20, h: 30 });
  assert.deepEqual(normCaptureRect(30, 50, 10, 20), { x: 10, y: 20, w: 20, h: 30 });
});

test("captureRectUsable 小于 8×8 视为误触", () => {
  const ok = { x: 0, y: 0, w: CAPTURE_MIN_PX, h: CAPTURE_MIN_PX };
  assert.ok(captureRectUsable(ok));
  assert.ok(!captureRectUsable({ x: 0, y: 0, w: CAPTURE_MIN_PX - 1, h: 20 }));
  assert.ok(!captureRectUsable({ x: 0, y: 0, w: 20, h: 2 }));
});

test("hitTestCapture 单页命中/跨页拒绝/空白忽略", () => {
  const slots = [
    { page: 1, x: 0, y: 0, w: 500, h: 700 },
    { page: 2, x: 0, y: 720, w: 500, h: 700 }, // 页间 20px 分隔带归页 2 槽
  ];
  assert.deepEqual(hitTestCapture({ x: 50, y: 50, w: 100, h: 100 }, slots), {
    kind: "ok",
    page: 1,
  });
  // 纵跨页缝 → cross
  assert.deepEqual(hitTestCapture({ x: 50, y: 690, w: 100, h: 100 }, slots).kind, "cross");
  // 落在页槽之外（两侧留白）→ none
  assert.deepEqual(hitTestCapture({ x: 600, y: 50, w: 50, h: 50 }, slots).kind, "none");
});

test("captureRectToCanvasPixels 按 DPR/缩放换算并钳到 canvas 内", () => {
  // canvas CSS 600×800，像素 1200×1600（dpr=2）
  const css = { x: 100, y: 200, w: 600, h: 800 };
  const r = captureRectToCanvasPixels(
    { x: 250, y: 400, w: 150, h: 200 },
    css,
    1200,
    1600,
  );
  assert.deepEqual(r, { sx: 300, sy: 400, sw: 300, sh: 400 });
  // 出圈部分裁掉：左/上越界 → 从 0 起算，宽高压小
  const clamped = captureRectToCanvasPixels(
    { x: 50, y: 150, w: 200, h: 200 },
    css,
    1200,
    1600,
  );
  assert.deepEqual(clamped, { sx: 0, sy: 0, sw: 300, sh: 300 });
  // 完全落在 canvas 外 → null
  assert.equal(
    captureRectToCanvasPixels({ x: 0, y: 0, w: 50, h: 50 }, css, 1200, 1600),
    null,
  );
});

test("formatReaderCapturePrompt 路径转义 + 预填 prompt + 出处", () => {
  assert.equal(
    formatReaderCapturePrompt("/tmp/ccode/paste-a.png", 3, "paper.pdf"),
    "/tmp/ccode/paste-a.png\n这张图/这段讲了什么？请结合论文解释。（paper.pdf，第 3 页圈选）",
  );
  // 含空格路径整体单引号包裹（终端粘贴图片同一口径）
  const out = formatReaderCapturePrompt("/tmp/my dir/p.png", 1, "a.pdf");
  assert.ok(out.startsWith("'/tmp/my dir/p.png'\n"), out);
  // Windows 侧显式传参（不读 IS_WINDOWS：Node 的 navigator.platform 在 Windows 上是
  // "Win32"，纯逻辑层若隐式读它，同一份用例在 mac 与 Windows 上结论会不一样）
  const win = formatReaderCapturePrompt("C:\\my dir\\p.png", 1, "a.pdf", true);
  assert.ok(win.startsWith('"C:\\my dir\\p.png"\n'), win);
  const winPlain = formatReaderCapturePrompt("C:\\d\\p.png", 1, "a.pdf", true);
  assert.ok(winPlain.startsWith("C:\\d\\p.png\n"), winPlain);
});

test("bytesToBase64 与 atob 互逆（分块编码）", () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  const b64 = bytesToBase64(bytes);
  const bin = atob(b64);
  assert.equal(bin.length, bytes.length);
  assert.equal(bin.charCodeAt(65536), bytes[65536]);
});

test("rewriteMdImageHtml 把待加载图换成占位 span，避免 WebView 拉相对路径", () => {
  const html = rewriteMdImageHtml(
    `<p><img src="./demo.gif" alt="演示"><img src="https://x/a.png"></p>`,
  );
  assert.equal(/<img\b/i.test(html), false);
  assert.match(html, /data-md-src="\.\/demo\.gif"/);
  assert.match(html, /data-md-alt="演示"/);
  assert.match(html, /data-md-src="https:\/\/x\/a\.png"/);
  assert.match(html, /md-img-pending/);
  assert.equal(
    rewriteMdImageHtml(`<img src="data:image/png;base64,xx">`),
    `<img src="data:image/png;base64,xx">`,
  );
});

test("fileUrlToPath / mdImageAbsPath", () => {
  assert.equal(fileUrlToPath("file:///Users/a/x.png"), "/Users/a/x.png");
  assert.equal(fileUrlToPath("file:///C:/a/x.png"), "C:/a/x.png");
  assert.equal(fileUrlToPath("https://a/x.png"), null);
  assert.equal(
    mdImageAbsPath("./demo.gif", "/proj/readme.md"),
    "/proj/demo.gif",
  );
  assert.equal(mdImageAbsPath("https://a/x.gif", "/proj/readme.md"), null);
  assert.equal(
    mdImageAbsPath(
      "/Users/u/Desktop/uTools/%E6%95%88%E6%9E%9C%E6%BC%94%E7%A4%BA/%E6%BC%94%E7%A4%BA1.png",
      "/Users/u/Desktop/uTools/uTools.md",
    ),
    "/Users/u/Desktop/uTools/效果演示/演示1.png",
  );
});

test("classifyMdHref 锚点/外链/其它协议/本地路径", () => {
  assert.equal(classifyMdHref("#小节"), "anchor");
  assert.equal(classifyMdHref("https://a.b/c"), "external");
  assert.equal(classifyMdHref("//a.b/c.png"), "external");
  assert.equal(classifyMdHref("mailto:x@y.z"), "other");
  assert.equal(classifyMdHref("assets/x.png"), "local");
  assert.equal(classifyMdHref("../papers/a.md"), "local");
  assert.equal(classifyMdHref("/abs/path/x.png"), "local");
});

test("stripMdHrefSuffix 去 query/fragment 并 URI 解码", () => {
  assert.equal(stripMdHrefSuffix("a%20b.png#frag"), "a b.png");
  assert.equal(stripMdHrefSuffix("x.md?y=1"), "x.md");
  // 非法编码保留原样
  assert.equal(stripMdHrefSuffix("100%.png"), "100%.png");
});

test("resolveMdPath 相对当前 md 目录解析", () => {
  assert.equal(
    resolveMdPath("/p/notes/a.md", "assets/x.png"),
    "/p/notes/assets/x.png",
  );
  assert.equal(resolveMdPath("/p/notes/sub/a.md", "../x.png"), "/p/notes/x.png");
  assert.equal(resolveMdPath("/p/notes/a.md", "./y.md"), "/p/notes/y.md");
  // 绝对路径原样归一（折叠 ..）
  assert.equal(resolveMdPath("/p/notes/a.md", "/q/./z/../w.png"), "/q/w.png");
  // Windows 盘符（分隔符归一）
  assert.equal(
    resolveMdPath("C:\\proj\\notes\\a.md", "assets\\x.png"),
    "C:/proj/notes/assets/x.png",
  );
});

test("relMdLinkPath 目标相对当前 md 目录（../ 回退）", () => {
  assert.equal(
    relMdLinkPath("/p/notes/a.md", "/p/notes/assets/x.png"),
    "assets/x.png",
  );
  assert.equal(relMdLinkPath("/p/notes/sub/a.md", "/p/notes/x.png"), "../x.png");
  // 同目录就是文件名
  assert.equal(relMdLinkPath("/p/notes/a.md", "/p/notes/b.png"), "b.png");
});

// ===== 批次 B3：翻译 prompt / 相对路径 / 生词本格式 / 段落提取 / 术语匹配 =====

test("buildReaderTranslatePrompt 学术直译约束 + 原文附上", () => {
  const p = buildReaderTranslatePrompt("interfacial resistance");
  assert.ok(p.includes("学术语境直译"));
  assert.ok(p.endsWith("\n\ninterfacial resistance"));
});

test("进度记忆与护眼的 localStorage 键格式", () => {
  assert.equal(readerProgressKey("/p/a.pdf"), "ccode.readerProgress./p/a.pdf");
  assert.equal(readerDarkKey("/p/a.pdf"), "ccode.readerDark./p/a.pdf");
});

test("译文卡钉位记忆：缺省原位，true 落键、false 清键", () => {
  // Node 测试无 localStorage：装个最小内存桩（UI 测试走 JSDOM，纯逻辑测试就地造）
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  assert.equal(loadReaderTlPinned(), false);
  saveReaderTlPinned(true);
  assert.equal(loadReaderTlPinned(), true);
  assert.equal(store.get(READER_TL_PINNED_KEY), "1");
  saveReaderTlPinned(false);
  assert.equal(loadReaderTlPinned(), false);
  assert.equal(store.get(READER_TL_PINNED_KEY), undefined);
});

test("译文悬浮球位置：归一到 0–100（贴边由渲染层 clamp 兜），坏值回落中部，记忆往返取整", () => {
  // 同上：本测试自带内存桩，不依赖前一个测试的装配
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  assert.deepEqual(clampReaderTlBall(-5, 120), { xp: 0, yp: 100 });
  assert.deepEqual(clampReaderTlBall(50, 50), { xp: 50, yp: 50 });
  assert.deepEqual(clampReaderTlBall(Number.NaN, 50).xp, 50);
  saveReaderTlBall(73.6, 28.4);
  assert.deepEqual(loadReaderTlBall(), { xp: 74, yp: 28 });
  store.delete("ccode.readerTlBall");
  assert.deepEqual(loadReaderTlBall(), { xp: 100, yp: 45 });
});

test("译文悬浮卡尺寸：下限常量、上限随栏钳制、坏值兜底；记忆往返与复位清键", () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  assert.deepEqual(clampReaderTlCard(100, 80, 1200, 900), { w: 240, h: 140 });
  assert.deepEqual(clampReaderTlCard(500, 2000, 1200, 900), { w: 500, h: 900 });
  // 上限比下限还小时不让倒挂（窄栏）：钳到下限
  assert.deepEqual(clampReaderTlCard(400, 400, 100, 100), { w: 240, h: 140 });
  assert.equal(loadReaderTlCard(), null); // 未拖过 = 自适应
  saveReaderTlCard({ w: 480, h: 320 });
  assert.deepEqual(loadReaderTlCard(), { w: 480, h: 320 });
  saveReaderTlCard(null);
  assert.equal(loadReaderTlCard(), null);
  assert.equal(store.get("ccode.readerTlCard"), undefined);
});

test("splitGlossaryRow 转义还原与尾单元处理", () => {
  assert.deepEqual(splitGlossaryRow("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(splitGlossaryRow("| C\\|D | x | y |"), ["C|D", "x", "y"]);
  // 缺尾竖线也能切
  assert.deepEqual(splitGlossaryRow("| a | b"), ["a", "b"]);
  // 非 | 起头不是表行
  assert.deepEqual(splitGlossaryRow("普通一行"), []);
  assert.deepEqual(splitGlossaryRow("|术语|释义|出处|"), ["术语", "释义", "出处"]);
});

test("escapeGlossaryCell 管道转义 + 换行折空格", () => {
  assert.equal(escapeGlossaryCell("a|b\nc"), "a\\|b c");
});

test("parseGlossaryTable 容错：非表行/表头/分隔/短行/空术语全跳过", () => {
  const text = [
    "# 生词本",
    "",
    "随手记",
    "| 术语 | 释义 | 出处 |",
    "| --- | --- | --- |",
    "| Alpha | 甲 | p1 |",
    "| 两列 | x |",
    "| | 空术语 | x |",
    "尾部备注",
  ].join("\n");
  assert.deepEqual(parseGlossaryTable(text), [
    { term: "Alpha", meaning: "甲", source: "p1" },
  ]);
});

test("glossary 渲染→解析往返稳定（格式契约锚点）", () => {
  const entries = [
    { term: "C|D 键", meaning: "某释义", source: "《p》第 1 页" },
    { term: "界面阻抗", meaning: "interfacial resistance", source: "《p》第 2 页" },
  ];
  const text = renderGlossaryTable(entries);
  assert.ok(text.startsWith("| 术语 | 释义 | 出处 |\n| --- | --- | --- |\n"));
  assert.deepEqual(parseGlossaryTable(text), entries);
});

test("groupTextLines 同视觉行拼接、跨行分行", () => {
  const spans = [
    { top: 100.2, left: 60, height: 12, text: "world" },
    { top: 100, left: 10, height: 12, text: "hello " },
    { top: 120, left: 10, height: 12, text: "next line" },
  ];
  const lines = groupTextLines(spans);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "hello world"); // 组内按 left 排序拼接
  assert.equal(lines[0].top, 100);
  assert.equal(lines[1].text, "next line");
});

test("isParagraphBreak 间隙 > 1.4 倍行高才算段界", () => {
  const a = { top: 0, height: 10, text: "a" };
  // 间隙 13 ≤ 14 → 同段
  assert.ok(!isParagraphBreak(a, { top: 23, height: 10, text: "b" }));
  // 间隙 15 > 14 → 段界
  assert.ok(isParagraphBreak(a, { top: 25, height: 10, text: "b" }));
  // 负间隙（行重叠）不算段界
  assert.ok(!isParagraphBreak(a, { top: 5, height: 10, text: "b" }));
});

test("paragraphBounds 从点击行向上下扩展", () => {
  // 行高 10：行内间隙 4，段界间隙 20
  const lines = [
    { top: 0, height: 10, text: "p1a" },
    { top: 14, height: 10, text: "p1b" },
    { top: 44, height: 10, text: "p2a" },
    { top: 58, height: 10, text: "p2b" },
    { top: 72, height: 10, text: "p2c" },
    { top: 102, height: 10, text: "p3a" },
  ];
  assert.deepEqual(paragraphBounds(lines, 0), { start: 0, end: 1 });
  assert.deepEqual(paragraphBounds(lines, 3), { start: 2, end: 4 });
  assert.deepEqual(paragraphBounds(lines, 5), { start: 5, end: 5 });
  // 越界下标钳制
  assert.deepEqual(paragraphBounds(lines, 99), { start: 5, end: 5 });
  assert.deepEqual(paragraphBounds([], 0), { start: 0, end: -1 });
});

test("nearestLineIndex 行内含中、行间取最近", () => {
  const lines = [
    { top: 0, height: 10, text: "a" },
    { top: 30, height: 10, text: "b" },
  ];
  assert.equal(nearestLineIndex(lines, 5), 0);
  assert.equal(nearestLineIndex(lines, 18), 0); // 距 a 底 8 < 距 b 顶 12
  assert.equal(nearestLineIndex(lines, 25), 1);
  assert.equal(nearestLineIndex(lines, 500), 1);
});

test("joinParagraphLines 行间换行、收尾空白", () => {
  assert.equal(
    joinParagraphLines([
      { top: 0, height: 10, text: " 第一段  " },
      { top: 14, height: 10, text: "第二行  " },
    ]),
    "第一段\n第二行",
  );
});

test("findGlossaryMatches 大小写不敏感 + 整词边界 + 长词优先", () => {
  const terms = [
    { term: "solid electrolyte", meaning: "固态电解质" },
    { term: "Li", meaning: "锂" },
    { term: "界面", meaning: "interface" },
  ];
  // 大小写不敏感 + 长词优先（solid electrolyte 整体命中，不再单拆 Li）
  const m1 = findGlossaryMatches("A Solid Electrolyte interface", terms);
  assert.deepEqual(m1, [
    { start: 2, end: 19, meaning: "固态电解质" },
  ]);
  // 整词边界：LiI 里的 Li 不命中；句尾 Li. 命中
  assert.deepEqual(findGlossaryMatches("LiI and LiF", terms), []);
  assert.deepEqual(findGlossaryMatches("metal Li.", terms), [
    { start: 6, end: 8, meaning: "锂" },
  ]);
  // CJK 术语按子串命中（无单词边界概念）
  assert.deepEqual(findGlossaryMatches("固液界面稳定性", terms), [
    { start: 2, end: 4, meaning: "interface" },
  ]);
  // 多次命中
  const m4 = findGlossaryMatches("Li anode, Li metal", terms);
  assert.equal(m4.length, 2);
  // 空术语表/空文本
  assert.deepEqual(findGlossaryMatches("text", []), []);
  assert.deepEqual(findGlossaryMatches("", terms), []);
});

test("findGlossaryMatches 术语含正则字符不炸", () => {
  const terms = [{ term: "C++", meaning: "语言" }];
  assert.deepEqual(findGlossaryMatches("written in C++.", terms), [
    { start: 11, end: 14, meaning: "语言" },
  ]);
  // 「C++11」：+ 非单词字符，尾边界放行——按术语原样命中（已知取舍）
  assert.deepEqual(findGlossaryMatches("in C++11", terms).length, 1);
});


test("translationSavedToast：笔记栏脏时明示不回显，干净时简洁口径", () => {
  assert.equal(translationSavedToast(false), "已存到笔记「译段」");
  const dirty = translationSavedToast(true);
  assert.ok(dirty.startsWith("已存到笔记「译段」"));
  assert.ok(dirty.includes("未保存改动"));
});


const tl = (original: string, over: Partial<TlHistoryEntry> = {}): TlHistoryEntry => ({
  original,
  translated: `译:${original}`,
  page: 1,
  saved: false,
  at: "2026-08-20T00:00:00.000Z",
  ...over,
});

test("upsertTlEntry：新条目置顶、封顶先进先出", () => {
  let list: TlHistoryEntry[] = [];
  list = upsertTlEntry(list, tl("b"));
  list = upsertTlEntry(list, tl("a"));
  assert.deepEqual(list.map((e) => e.original), ["a", "b"]);
  // 封顶：灌满后再加，最旧的（尾部）裁掉
  list = Array.from({ length: READER_TL_HISTORY_MAX }, (_, i) => tl(`t${i}`));
  list = upsertTlEntry(list, tl("new"));
  assert.equal(list.length, READER_TL_HISTORY_MAX);
  assert.equal(list[0].original, "new");
  assert.equal(list.at(-1)!.original, `t${READER_TL_HISTORY_MAX - 2}`);
  assert.ok(!list.some((e) => e.original === `t${READER_TL_HISTORY_MAX - 1}`));
});

test("upsertTlEntry：同原文重翻 = 替换置顶且保留已存标记", () => {
  let list = upsertTlEntry([tl("x")], tl("y"));
  list = markTlEntrySaved(list, "x");
  list = upsertTlEntry(list, tl("x", { translated: "新译", at: "2026-08-20T01:00:00.000Z" }));
  assert.equal(list.length, 2);
  assert.equal(list[0].original, "x");
  assert.equal(list[0].translated, "新译");
  assert.equal(list[0].saved, true, "重翻不洗掉已存状态");
});

test("markTlEntrySaved：按原文标记，找不到原样返回", () => {
  const list = [tl("a"), tl("b")];
  const marked = markTlEntrySaved(list, "b");
  assert.equal(marked[1].saved, true);
  assert.equal(marked[0].saved, false);
  assert.deepEqual(markTlEntrySaved(list, "zzz").map((e) => e.saved), [false, false]);
});


test("parseBilingual：正常多对解析（全/半角冒号都收）", () => {
  const raw = "原：Redox mediators are promising.\n译：氧化还原介体很有前景。\n\n原:They stabilize sulfur.\n译:它们能稳定硫。";
  assert.deepEqual(parseBilingual(raw), [
    { src: "Redox mediators are promising.", zh: "氧化还原介体很有前景。" },
    { src: "They stabilize sulfur.", zh: "它们能稳定硫。" },
  ]);
});

test("parseBilingual：缺对 / 乱序 / 空行拆对 → null", () => {
  // 末尾缺译行
  assert.equal(parseBilingual("原：A\n译：甲\n\n原：B"), null);
  // 「译」在「原」前
  assert.equal(parseBilingual("译：甲\n原：A"), null);
  // 「原」接「原」（上一对缺译）
  assert.equal(parseBilingual("原：A\n原：B\n译：乙"), null);
  // 空行把一对拆开
  assert.equal(parseBilingual("原：A\n\n译：甲"), null);
  // 空句不收
  assert.equal(parseBilingual("原：\n译：甲"), null);
});

test("parseBilingual：旧格式纯译文 / 混入其他行 → null（回落纯译文视图）", () => {
  assert.equal(parseBilingual("这是一段纯译文，没有对照标记。"), null);
  assert.equal(parseBilingual("原：A\n译：甲\n备注：多出来的一行"), null);
  assert.equal(parseBilingual(""), null);
});

test("plainFromBilingual：只取译行逐句拼接（存进笔记的纯译文）", () => {
  const pairs = parseBilingual("原：A one.\n译：甲一。\n\n原：B two.\n译：乙二。")!;
  assert.equal(plainFromBilingual(pairs), "甲一。\n乙二。");
});


test("reflowBlockText：断词接回 / 英文单换行转空格", () => {
  assert.equal(
    reflowBlockText("com-\nprised of sev-\neral parts", { cjk: false }),
    "comprised of several parts",
  );
  assert.equal(
    reflowBlockText("first line\nsecond line", { cjk: false }),
    "first line second line",
  );
});

test("reflowBlockText：中文单换行直连不加空格", () => {
  assert.equal(
    reflowBlockText("氧化还原介体\n很有前景", { cjk: true }),
    "氧化还原介体很有前景",
  );
});

test("reflowBlockText：连续空行压成单换行（不留空行）+ 行首 trim", () => {
  assert.equal(
    reflowBlockText("  第一段 \n\n\n  第二段", { cjk: false }),
    "第一段\n第二段",
  );
  assert.equal(
    reflowBlockText("  第一段 \n\n\n  第二段", { cjk: true }),
    "第一段\n第二段",
  );
});

test("reflowBlockText：组合场景（断词 + 段内换行 + 空行 + trim）", () => {
  const raw = "Redox medi-\nators show promise.\n\n  They stabil-\nize sulfur. ";
  assert.equal(
    reflowBlockText(raw, { cjk: false }),
    "Redox mediators show promise.\nThey stabilize sulfur.",
  );
});
