import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
