import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 2026-10-23 用户拍板：综述拼图 = 一个论点，从几篇里各取一块子图。裁子图有三条路：
// --panel 按白缝切格子，--grid 出坐标预览后 --box 按比例裁，--erase 抹掉原图子图字母；
// 题注认不出时 --page 按整页走 --grid / --box。
const python = process.platform === "win32" ? "python" : "python3";
const script = resolve("src-tauri/resources/skills/review-figures/scripts/extract_figure.py");
const ready = spawnSync(python, ["-c", "import pymupdf, PIL"], { encoding: "utf8" }).status === 0;

/** 一页 PDF：上半页嵌一张 2×2 四色子图（40 px 白缝隔开，左上角各有一个黑块当子图字母），下面一行题注 Figure 1. */
function makePdf(dir: string): string {
  const pdf = join(dir, "paper.pdf");
  const code = [
    "import sys, io, pymupdf",
    "from PIL import Image, ImageDraw",
    "im = Image.new('RGB', (400, 300), 'white'); d = ImageDraw.Draw(im)",
    "cols = [(220,0,0), (0,160,0), (0,0,220), (230,160,0)]",
    "for i, c in enumerate(cols):",
    "    x0 = (i % 2) * 220; y0 = (i // 2) * 170",
    "    d.rectangle([x0, y0, x0 + 179, y0 + 129], fill=c)",
    "    d.rectangle([x0 + 2, y0 + 2, x0 + 16, y0 + 14], fill=(0, 0, 0))",
    "buf = io.BytesIO(); im.save(buf, 'PNG')",
    "doc = pymupdf.open(); page = doc.new_page(width=595, height=842)",
    "page.insert_image(pymupdf.Rect(97, 100, 497, 400), stream=buf.getvalue())",
    "page.insert_text((97, 420), 'Figure 1. Four panels.', fontsize=10)",
    "doc.save(sys.argv[1])",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, pdf], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return pdf;
}

/** 输出图的尺寸与左上、中心像素 */
function probe(png: string) {
  const r = spawnSync(
    python,
    ["-c", "import sys, json; from PIL import Image; im = Image.open(sys.argv[1]).convert('RGB'); w, h = im.size; print(json.dumps({'w': w, 'h': h, 'corner': im.getpixel((int(w*0.04), int(h*0.06))), 'center': im.getpixel((w//2, h//2))}))", png],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { w: number; h: number; corner: number[]; center: number[] };
}

// 中文 Windows 上 Python 的 stderr 默认 GBK：报错文案按 UTF-8 读
const run = (args: string[]) =>
  spawnSync(python, [script, ...args], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });

test("裁子图：--panel 按白缝切到第二块；--box 按比例裁；--erase 抹掉角上的原图字母", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-fig-"));
  try {
    const pdf = makePdf(dir);
    // --panel b：右上那块（绿）。带 clip 渲出的 pixmap 原点不在 (0,0)，以前切出来是空的
    let r = run(["--pdf", pdf, "--fig", "1", "--panel", "b", "--dpi", "144", "--out", join(dir, "b.png")]);
    assert.equal(r.status, 0, r.stderr);
    const b = probe(join(dir, "b.png"));
    assert.deepEqual(b.center.map((v) => Math.round(v / 40)), [0, 4, 0], "第二块是绿色");
    // --grid：整图预览，不裁
    r = run(["--pdf", pdf, "--fig", "1", "--grid", "--out", join(dir, "grid.png")]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "grid.png")));
    // --box 左下那块（蓝），--erase 抹掉它左上角的黑块
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0.5,0.5,1", "--erase", "0,0,0.12,0.12", "--dpi", "144", "--out", join(dir, "c.png")]);
    assert.equal(r.status, 0, r.stderr);
    const c = probe(join(dir, "c.png"));
    assert.deepEqual(c.center.map((v) => Math.round(v / 40)), [0, 0, 6], "裁到的是蓝块");
    assert.deepEqual(c.corner, [255, 255, 255], "原图字母抹白了");
    assert.ok(Math.abs(c.w / c.h - 4 / 3) < 0.25, "按比例裁，不拉伸");
    // 框的边切进色块（读坐标读偏了）：拒绝，退出码 7
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0.5,0.3,1", "--out", join(dir, "cut.png")]);
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stderr, /裁框切进了内容（右边/);
    // 上边、右边略微读进色块里：往框外挪到最近的空白线，整块照常裁下
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0.58,0.43,1", "--dpi", "144", "--out", join(dir, "snap.png")]);
    assert.equal(r.status, 0, r.stderr);
    const snapped = r.stdout.match(/实际裁框（已挪到空白缝）：([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    assert.ok(snapped, r.stdout);
    assert.ok(Number(snapped[2]) < 0.57 && Number(snapped[3]) > 0.44, "上边往上、右边往右挪出了色块");
    // --no-snap：不挪，照样查边——切进色块仍拒绝；两个 --erase 都生效
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0.58,0.43,1", "--no-snap", "--out", join(dir, "ns.png")]);
    assert.equal(r.status, 7, r.stderr);
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0.5,0.5,1", "--no-snap", "--erase", "0,0,0.12,0.12", "--erase", "0.9,0,1,0.1", "--dpi", "144", "--out", join(dir, "two.png")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /实际裁框（未挪）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("裁子图：--erase 只许角上的小框；--page 只配 --grid / --box；框住大半页拒绝", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-fig-"));
  try {
    const pdf = makePdf(dir);
    let r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0,0.5,0.5", "--erase", "0.4,0.4,0.6,0.6", "--out", join(dir, "x.png")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /左上或右上角|2%/);
    r = run(["--pdf", pdf, "--page", "1", "--out", join(dir, "p.png")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--page 只配 --grid 或 --box/);
    r = run(["--pdf", pdf, "--page", "1", "--box", "0,0,1,0.95", "--out", join(dir, "p.png")]);
    assert.equal(r.status, 4, r.stderr);
    r = run(["--pdf", pdf, "--page", "1", "--box", "0.16,0.11,0.84,0.48", "--dpi", "72", "--out", join(dir, "p.png")]);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-24 用户：系统综述一段论述可能拼 9 块。块数不设死上限，按印出来读不读得清卡
const assemble = resolve("src-tauri/resources/skills/review-figures/scripts/assemble_panels.py");

test("拼板：9 块排 3×3 照常出图；一行挤太多、单栏放 3 块读不清就拒绝", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-asm-"));
  try {
    const panel = join(dir, "p.png");
    const made = spawnSync(python, ["-c", "import sys; from PIL import Image; Image.new('RGB', (600, 450), (200, 60, 60)).save(sys.argv[1])", panel], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const row = (n: number) => Array(n).fill(panel).join(" ");
    const go = (args: string[]) =>
      spawnSync(python, [assemble, "--out", join(dir, "out.png"), ...args], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let r = go(["--width-cm", "17", "--rows", row(3), row(3), row(3)]);
    assert.equal(r.status, 0, r.stderr);
    r = go(["--width-cm", "17", "--rows", row(5), row(4)]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /不到 3\.5 cm 宽/);
    r = go(["--width-cm", "8.5", "--inputs", panel, panel, panel]);
    assert.equal(r.status, 3);
    // 太高：整宽的块一行一块竖排三块，整张超过一页
    r = go(["--width-cm", "17", "--rows", panel, panel, panel]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /超过一页/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-24 用户：拼图是从 PDF 裁的，作者投稿前要去期刊换原图，每块从哪取的要写清
const sourcesScript = resolve("src-tauri/resources/skills/review-figures/scripts/figure_sources.py");

test("来源清单：每块的原文、DOI、原图编号与 PDF 页码汇总进 figures/sources.md", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-fig-src-"));
  try {
    const pdf = makePdf(dir);
    const figures = join(dir, "figures");
    const src = join(figures, "src");
    let r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0,0.5,0.5", "--label", "Fig. 1(a)", "--dpi", "72", "--out", join(src, "Doe2020-fig1a.png")]);
    assert.equal(r.status, 0, r.stderr);
    r = run(["--pdf", pdf, "--fig", "1", "--panel", "b", "--dpi", "144", "--key", "Roe2021", "--out", join(src, "other-b.png")]);
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(python, [assemble, "--out", join(figures, "fig1.png"), "--width-cm", "8.5", "--inputs", join(src, "Doe2020-fig1a.png"), join(src, "other-b.png")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(figures, "fig1.md"), "**Figure 1.** Colours differ across studies. (a) red. (b) green.");
    writeFileSync(
      join(dir, "references.bib"),
      "@article{Doe2020,\n  title = {【7】Red panels},\n  author = {Doe, Jane and Poe, Al and Zoe, Bo},\n  year = {2020},\n  journal = {J. Colour},\n  volume = {3},\n  pages = {10--20},\n  doi = {10.1/red},\n}\n" +
        "@article{Roe2021,\n  title = {Green panels},\n  author = {Roe, Rick},\n  year = {2021},\n  journal = {Colour Lett.},\n  doi = {10.1/green},\n}\n",
    );
    r = spawnSync(python, [sourcesScript, "--figures", figures, "--bib", join(dir, "references.bib")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(figures, "sources.md"), "utf8");
    assert.match(md, /## Figure 1/);
    assert.match(md, /论点：Colours differ across studies\./);
    assert.match(md, /\| \(a\) \| Doe et al\., 2020, \*J\. Colour\* 3, 10–20 — Red panels \[@Doe2020\] \| Fig\. 1\(a\)，PDF 第 1 页，裁框 /);
    assert.match(md, /\[10\.1\/red\]\(https:\/\/doi\.org\/10\.1\/red\)/);
    assert.match(md, /\| \(b\) \| Roe, 2021, \*Colour Lett\.\* — Green panels \[@Roe2021\] \| Fig\. 1\(b\)，PDF 第 1 页/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-24 用户：定稿步提醒换原图和申请许可。许可只能作者本人申请，AI 只做清单
const permScript = resolve("src-tauri/resources/skills/review-figures/scripts/figure_permissions.py");

test("转载许可清单：CC BY 的标无需申请，其余标待申请，图注出处按许可写", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-fig-perm-"));
  try {
    const pdf = makePdf(dir);
    const figures = join(dir, "figures");
    const src = join(figures, "src");
    let r = run(["--pdf", pdf, "--fig", "1", "--box", "0,0,0.5,0.5", "--label", "Fig. 1(a)", "--dpi", "72", "--out", join(src, "Open2020-fig1a.png")]);
    assert.equal(r.status, 0, r.stderr);
    r = run(["--pdf", pdf, "--fig", "1", "--box", "0.5,0,1,0.5", "--label", "Fig. 3(b)", "--dpi", "72", "--out", join(src, "Shut2019-fig3b.png")]);
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(python, [assemble, "--out", join(figures, "fig1.png"), "--width-cm", "8.5", "--inputs", join(src, "Open2020-fig1a.png"), join(src, "Shut2019-fig3b.png")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(
      join(dir, "references.bib"),
      "@article{Open2020,\n  title = {Open},\n  author = {Doe, Jane},\n  year = {2020},\n  journal = {J. Open},\n  doi = {10.1/open},\n}\n" +
        "@article{Shut2019,\n  title = {Shut},\n  author = {Roe, Rick},\n  year = {2019},\n  journal = {J. Shut},\n  doi = {10.1/shut},\n}\n",
    );
    // Crossref 打桩：一篇 CC BY，一篇只有出版商的文本挖掘许可
    const code = [
      "import sys, importlib.util",
      "spec = importlib.util.spec_from_file_location('fp', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "fake = {'10.1/open': {'publisher': 'Open Press', 'license': [{'URL': 'http://creativecommons.org/licenses/by/4.0/', 'content-version': 'vor'}]},",
      "        '10.1/shut': {'publisher': 'Shut Inc', 'license': [{'URL': 'https://www.elsevier.com/tdm/userlicense/1.0/', 'content-version': 'tdm'}]}}",
      "sys.stdout.reconfigure(encoding='utf-8')",
      "print(m.build(m.Path(sys.argv[2]), m.Path(sys.argv[3]), lambda doi: fake.get(doi, {})))",
    ].join("\n");
    r = spawnSync(python, ["-c", code, permScript, figures, join(dir, "references.bib")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const md = r.stdout;
    assert.match(md, /拼图共 2 块，其中 1 块要向出版社申请转载许可/);
    assert.match(md, /\| 1\(a\) \|.*\| Fig\. 1\(a\) \| Open Press \| \[CC BY 4\.0\].*\| Adapted from Fig\. 1\(a\) of \[@Open2020\], licensed under CC BY 4\.0\. \| 无需申请 \|/);
    assert.match(md, /\| 1\(b\) \|.*\| Fig\. 3\(b\) \| Shut Inc \| 非开放获取.*\| Adapted with permission from Fig\. 3\(b\) of \[@Shut2019\]\. Copyright 2019 Shut Inc\. \| 待申请 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("裁图也收期刊下载的原图图片：整张就是这张图，按它自己的像素裁", { skip: !ready }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mesa-fig-img-"));
  try {
    const img = join(dir, "orig.png");
    const made = spawnSync(python, ["-c", "import sys; from PIL import Image, ImageDraw; im = Image.new('RGB', (800, 400), 'white'); d = ImageDraw.Draw(im); d.rectangle([20, 20, 380, 380], fill=(0, 0, 200)); d.rectangle([420, 20, 780, 380], fill=(0, 150, 0)); im.save(sys.argv[1], dpi=(96, 96))", img], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const r = run(["--pdf", img, "--box", "0.5,0,1,1", "--label", "Fig. 2(b)", "--key", "Orig2020", "--out", join(dir, "b.png")]);
    assert.equal(r.status, 0, r.stderr);
    const b = probe(join(dir, "b.png"));
    assert.ok(Math.abs(b.w - 400) <= 2, `按原图像素裁，不按 dpi 放大：${b.w}`);
    assert.deepEqual(b.center.map((v) => Math.round(v / 50)), [0, 3, 0]);
    const side = JSON.parse(readFileSync(join(dir, "b.json"), "utf8"));
    assert.equal(side.label, "Fig. 2(b)");
    assert.equal(side.key, "Orig2020");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
