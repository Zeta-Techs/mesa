import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 2026-11-05 科研做图拍板（docs/design-research-figures.md）：示意图由图纸 figure.json 渲成可编辑 PPTX + SVG，
// 检查三档不打总分，人改过的文件为准。这里跑真脚本；本机缺 Pillow / python-pptx 时跳过（CI 不装这两个）。
const python = process.platform === "win32" ? "python" : "python3";
const dir = resolve("src-tauri/resources/skills/schematic-forge/scripts");
const ready = spawnSync(python, ["-c", "import PIL, pptx"], { encoding: "utf8" }).status === 0;
const hasNumpy = spawnSync(python, ["-c", "import numpy; from PIL import ImageFont; ImageFont.load_default(size=10)"], { encoding: "utf8" }).status === 0;
const opts = { skip: ready ? false : "缺 Pillow / python-pptx" };

function run(cwd: string, script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(python, [join(dir, script), ...args], {
    cwd, encoding: "utf8", env: { ...process.env, MESA_FIGURE_TOOL: "", PYTHONIOENCODING: "utf-8", ...env },
  });
}

function project(spec: object, brief = "", facts = ""): string {
  const root = mkdtempSync(join(tmpdir(), "schematic-"));
  mkdirSync(join(root, "figures", "t"), { recursive: true });
  writeFileSync(join(root, "figures", "t", "figure.json"), JSON.stringify(spec));
  if (brief) writeFileSync(join(root, "figures", "t", "brief.md"), brief);
  if (facts) writeFileSync(join(root, "figures", "t", "facts.md"), facts);
  return root;
}

const base = {
  name: "t",
  canvas: { width_mm: 89, height_mm: 50, purpose: "journal" },
  theme: { base_pt: 7, colors: { primary: "#1F4E79" } },
  elements: [
    { id: "a", type: "box", x: 4, y: 10, w: 30, h: 20, fill: "primary@15", stroke: "primary", text: "Adsorbent" },
    { id: "b", type: "ellipse", x: 55, y: 10, w: 28, h: 20, stroke: "primary", text: "Active site" },
    { id: "ab", type: "arrow", from: "a", to: "b", stroke: "primary" },
  ],
};

function checks(root: string, name = "t") {
  const text = readFileSync(join(root, ".ccode", "checks", `schematic-${name}.jsonl`), "utf8");
  return text.trim().split("\n").map((l) => JSON.parse(l) as { id: string; status: string; title: string });
}

test("图纸渲成 SVG（真文字）+ PPTX（形状按元素 id 命名、文字是文本框），记录哈希并登记 manifest", opts, () => {
  const root = project(base);
  try {
    const r = run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx"]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(join(root, "figures/t/t.svg"), "utf8");
    assert.match(svg, /<text[^>]*><tspan[^>]*>Adsorbent<\/tspan>/);
    assert.match(svg, /width="89mm" height="50mm"/);
    assert.match(svg, /marker-end="url\(#ah-/);
    const shapes = spawnSync(python, ["-c",
      "import sys; from pptx import Presentation\np=Presentation(sys.argv[1])\nprint('|'.join(f'{s.name}={s.text_frame.text if s.has_text_frame else \"\"}' for s in p.slides[0].shapes))",
      join(root, "figures/t/t.pptx")], { encoding: "utf8" });
    assert.equal(shapes.status, 0, shapes.stderr);
    assert.match(shapes.stdout, /a=Adsorbent\|b=Active site\|ab=/);
    const rec = JSON.parse(readFileSync(join(root, "figures/t/render.json"), "utf8"));
    assert.ok(rec.outputs.svg && rec.outputs.pptx);
    const manifest = JSON.parse(readFileSync(join(root, "figures/manifest.json"), "utf8"));
    assert.deepEqual(manifest.figures[0], { file: "figures/t/t.svg", spec: "figures/t/figure.json", kind: "schematic", outputs: ["figures/t/t.pptx"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("人改过的 PPTX 为准：渲染器拒绝覆盖（退出码 4），pptx_edit 只在人改过的那份上改，--force 才推倒重来", opts, () => {
  const root = project(base);
  try {
    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx"]).status, 0);
    // 还是生成原样：pptx_edit 拒绝，要改图纸重渲
    assert.equal(run(root, "pptx_edit.py", ["set-text", "figures/t/t.pptx", "--shape", "a", "--text", "X"]).status, 2);
    // 人在 PowerPoint 里挪了一下
    const moved = spawnSync(python, ["-c",
      "import sys; from pptx import Presentation\np=Presentation(sys.argv[1]); s=[x for x in p.slides[0].shapes if x.name=='a'][0]; s.left+=36000; p.save(sys.argv[1])",
      join(root, "figures/t/t.pptx")], { encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
    const again = run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx"]);
    assert.equal(again.status, 4);
    assert.match(again.stderr, /人改过/);
    const edit = run(root, "pptx_edit.py", ["set-text", "figures/t/t.pptx", "--shape", "a", "--text", "Sorbent"]);
    assert.equal(edit.status, 0, edit.stderr);
    assert.ok(existsSync(join(root, "figures/t/.history")));
    const check = run(root, "schematic_check.py", ["figures/t/figure.json"]);
    assert.ok(checks(root).some((c) => c.id === "EDITED" && c.status === "needs_human"), check.stdout);
    assert.equal(run(root, "pptx_edit.py", ["set-text", "figures/t/t.pptx", "--shape", "nope", "--text", "X"]).status, 2);
    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx", "--force"]).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("检查：图上文字要在 brief / facts 里有原文；facts 写的关系没画或画反拦下；文字相交、字号过小拦下；冷读永远交人", opts, () => {
  const spec = {
    ...base,
    elements: [
      ...base.elements,
      { id: "c", type: "text", x: 4, y: 36, w: 40, h: 6, text: "Unsourced claim here", pt: 4 },
      { id: "d", type: "text", x: 6, y: 36, w: 40, h: 6, text: "Adsorbent" },
    ],
  };
  const facts = "- Adsorbent\n- Active site\n- 关系：a → b（用户）\n- 关系：Active site → Adsorbent（用户）\n- 关系：a → c（用户）\n";
  const root = project(spec, "# 立意\n一句话\n", facts);
  try {
    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]).status, 0);
    const r = run(root, "schematic_check.py", ["figures/t/figure.json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const items = checks(root);
    const by = (p: string) => items.filter((i) => i.id.startsWith(p));
    assert.ok(by("SOURCE-c").every((i) => i.status === "blocked") && by("SOURCE-c").length === 1);
    assert.equal(by("SOURCE-a").length, 0);
    assert.deepEqual(items.filter((i) => i.id.startsWith("REL-")).map((i) => i.status), ["passed", "blocked", "blocked"]);
    assert.match(items.find((i) => i.id === "REL-4")!.title, /画反/);
    assert.ok(by("CLASH-").some((i) => i.status === "blocked"));
    assert.ok(by("MINPT-c").some((i) => i.status === "blocked"));
    assert.equal(items.find((i) => i.id === "COLD-READ")!.status, "needs_human");
    assert.ok(items.every((i) => ["passed", "blocked", "needs_human"].includes(i.status)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("检查：缺 brief / facts 拦下；改了图纸没重渲拦下；重渲后重建一致通过", opts, () => {
  const root = project(base);
  try {
    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]).status, 0);
    run(root, "schematic_check.py", ["figures/t/figure.json"]);
    assert.ok(checks(root).some((i) => i.id === "MISSING-BRIEF" && i.status === "blocked"));
    assert.ok(checks(root).some((i) => i.id === "REBUILD" && i.status === "passed"));
    const spec = JSON.parse(readFileSync(join(root, "figures/t/figure.json"), "utf8"));
    spec.elements[0].x = 5;
    writeFileSync(join(root, "figures/t/figure.json"), JSON.stringify(spec));
    run(root, "schematic_check.py", ["figures/t/figure.json"]);
    assert.ok(checks(root).some((i) => i.id === "REBUILD" && i.status === "blocked"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("图纸有错时说清哪里错：未知元素类型、重复 id、连线指向不存在的元素", opts, () => {
  for (const [els, re] of [
    [[{ id: "x", type: "star", x: 0, y: 0, w: 1, h: 1 }], /不认识/],
    [[{ id: "x", type: "box", x: 0, y: 0, w: 5, h: 5 }, { id: "x", type: "box", x: 0, y: 0, w: 5, h: 5 }], /重复/],
    [[{ id: "x", type: "box", x: 0, y: 0, w: 5, h: 5 }, { id: "l", type: "arrow", from: "x", to: "y" }], /不是任何元素/],
  ] as const) {
    const root = project({ ...base, elements: els });
    try {
      const r = run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, re);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("素材板：按格切开成透明底图标；某格图形碰到格边就整板拒绝、一个都不留", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "sheet-"));
  try {
    const make = spawnSync(python, ["-c", [
      "import sys; from PIL import Image, ImageDraw",
      "im = Image.new('RGB', (600, 200), (255, 0, 255)); d = ImageDraw.Draw(im)",
      "d.ellipse([50, 40, 150, 160], fill=(40, 90, 160)); d.rectangle([250, 50, 350, 150], fill=(230, 120, 30)); d.polygon([(500, 40), (560, 160), (440, 160)], fill=(60, 160, 80))",
      "im.save(sys.argv[1] + '/ok.png')",
      "d.rectangle([180, 80, 220, 120], fill=(0, 0, 0)); im.save(sys.argv[1] + '/bad.png')",
    ].join("\n"), root], { encoding: "utf8" });
    assert.equal(make.status, 0, make.stderr);
    const ok = run(root, "asset_sheet.py", ["split", "ok.png", "--grid", "3x1", "--names", "p,q,r", "--out-dir", "out"]);
    assert.equal(ok.status, 0, ok.stderr);
    const px = spawnSync(python, ["-c", "import sys; from PIL import Image\nim=Image.open(sys.argv[1]); print(im.mode, im.getpixel((0,0))[3])", join(root, "out/p.png")], { encoding: "utf8" });
    assert.match(px.stdout, /RGBA 0/);
    const bad = run(root, "asset_sheet.py", ["split", "bad.png", "--grid", "3x1", "--names", "p,q,r", "--out-dir", "out2"]);
    assert.equal(bad.status, 3);
    assert.equal(existsSync(join(root, "out2/q.png")), false);
    const prompt = run(root, "asset_sheet.py", ["prompt", "--names", "p,q", "--subjects", "颗粒,分子"]);
    assert.match(prompt.stdout, /#FF00FF/);
    assert.match(prompt.stdout, /No text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("组图：子图 SVG 缩放后最小字号低于下限拦下；--wrap 把单张图包成带图注的一页，PPTX 里挂 SVG 原件", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "compose-"));
  try {
    mkdirSync(join(root, "figures", "t"), { recursive: true });
    writeFileSync(join(root, "figures", "fig2.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="252pt" height="180pt" viewBox="0 0 252 180"><rect x="10" y="10" width="200" height="150" fill="#ddd"/><text x="20" y="170" style="font: 7px \'Arial\'">Time</text></svg>');
    const spec = { name: "t", canvas: { width_mm: 89, height_mm: 40, purpose: "journal" },
      elements: [{ id: "pa", type: "figure", x: 0, y: 0, w: 44, h: 32, src: "../fig2.svg", label: "a" },
        { id: "pb", type: "figure", x: 45, y: 1, w: 44, h: 32, src: "../fig2.svg", label: "b" }] };
    writeFileSync(join(root, "figures/t/figure.json"), JSON.stringify(spec));
    writeFileSync(join(root, "figures/t/brief.md"), "x");
    writeFileSync(join(root, "figures/t/facts.md"), "x");
    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]).status, 0);
    run(root, "schematic_check.py", ["figures/t/figure.json"]);
    const items = checks(root);
    assert.ok(items.some((i) => i.id === "PANELPT-pa" && i.status === "blocked"), JSON.stringify(items));
    assert.ok(items.some((i) => i.id.startsWith("LABELROW-") && i.status === "needs_human"));
    const w = run(root, "render_figure.py", ["--wrap", "figures/fig2.svg", "--caption", "Fig. 2", "--formats", "svg,pptx"]);
    assert.equal(w.status, 0, w.stderr);
    const zip = spawnSync(python, ["-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", join(root, "figures/fig2-slide/fig2-slide.pptx")], { encoding: "utf8" });
    // 没有 SVG 转图工具时 PPTX 里是灰色占位；有工具时挂 SVG 原件
    assert.ok(/mesa-svg1\.svg/.test(zip.stdout) || /没有 SVG 转图工具/.test(w.stdout), zip.stdout + w.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("复刻：按墨迹量文字行，框线不算字；同级字号聚成一组", { skip: ready && hasNumpy ? false : "缺 Pillow 10.1+ / numpy" }, () => {
  const root = mkdtempSync(join(tmpdir(), "measure-"));
  try {
    const make = spawnSync(python, ["-c", [
      "import sys; from PIL import Image, ImageDraw",
      "im = Image.new('RGB', (1200, 400), 'white'); d = ImageDraw.Draw(im)",
      "from PIL import ImageFont",
      "d.rectangle([20, 100, 600, 380], outline=(31, 78, 121), width=4)",
      "d.text((60, 30), 'Adsorbent design', font=ImageFont.load_default(size=48), fill='black')",
      "for y in (140, 220): d.text((60, y), 'Support modification', font=ImageFont.load_default(size=28), fill='black')",
      "im.save(sys.argv[1] + '/src.png')",
    ].join("\n"), root], { encoding: "utf8" });
    assert.equal(make.status, 0, make.stderr);
    const r = run(root, "measure_text.py", ["src.png", "--width-mm", "120", "--out", "m.json"]);
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(root, "m.json"), "utf8"));
    const text = m.segments.filter((s: { kind: string }) => s.kind === "text");
    assert.equal(text.length, 3);
    assert.equal(new Set(text.map((s: { group: number }) => s.group)).size, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("内置图元：每个都能放进图纸渲染，默认色全部替换、不残留 @C 占位；index.json 与文件一一对应", opts, () => {
  const idx = JSON.parse(readFileSync(join(dir, "icons", "index.json"), "utf8")) as { icons: { name: string; zh: string }[] };
  assert.ok(idx.icons.length >= 60);
  const elements = idx.icons.map((ic, i) => ({ id: `i${i}`, type: "image", x: (i % 10) * 9, y: Math.floor(i / 10) * 9, w: 8, h: 8, src: `lib:${ic.name}` }));
  const root = project({ name: "t", canvas: { width_mm: 90, height_mm: Math.ceil(elements.length / 10) * 9, purpose: "slide" }, elements });
  try {
    const r = run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(join(root, "figures/t/t.svg"), "utf8");
    assert.equal(/@C\d@/.test(svg), false);
    assert.equal(/<text/.test(svg), false);
    const recolor = project({ name: "t", canvas: { width_mm: 20, height_mm: 20 },
      elements: [{ id: "b", type: "image", x: 0, y: 0, w: 20, h: 20, src: "lib:beaker", colors: { C1: "#123456" } }] });
    try {
      assert.equal(run(recolor, "render_figure.py", ["figures/t/figure.json", "--formats", "svg"]).status, 0);
      assert.match(readFileSync(join(recolor, "figures/t/t.svg"), "utf8"), /#123456/);
    } finally { rmSync(recolor, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("排版：粗体里套上下标、℃ 与圈号走中文字体不算缺字、上下标和收尾标点不单独成行、窄框换行不崩、写错的标记拦下", opts, () => {
  const code = [
    "import sys, json; sys.path.insert(0, sys.argv[1]); import figlib as F",
    "print(json.dumps(F.parse_rich('**NiFeB_{0.33}-700** η_{10}')[0]))",
    "spec = {'canvas': {'width_mm': 60, 'height_mm': 40}, 'theme': {}, 'elements': [{'id': 'x', 'type': 'text', 'x': 0, 'y': 0, 'w': 1, 'h': 1}]}",
    "spec['theme'].update({'font': F.DEFAULT_LATIN, 'font_cjk': F.DEFAULT_CJK, 'base_pt': 7, 'text_color': '#222222', 'colors': {}})",
    "b = F.FontBook()",
    "def lay(text, w, pt=7): return F.layout_text(spec, {'text': text, 'pt': pt}, (0, 0, w, 30), b, True)",
    "has_cjk = b.pick(F.DEFAULT_CJK) is not None",
    "l = lay('100 h 电位变化 4.4%', 24.5)",
    "lines = [''.join(r[0] for r in x['runs']) for x in l['lines']]",
    "l2 = lay('Tafel 111.1 mV dec^{-1}', 21)",
    "lines2 = [''.join(r[0] for r in x['runs']) for x in l2['lines']]",
    "l3 = lay('OER 能垒 1.87 → 1.58（NiFe → NiFeB）', 32)",
    "lines3 = [''.join(r[0] for r in x['runs']) for x in l3['lines']]",
    "l4 = lay('700 ℃ ① 样品', 40)",
    "print(json.dumps({'cjk': has_cjk, 'lines': lines, 'lines2': lines2, 'lines3': lines3, 'missing': l4['missing'], 'orph3': l3['orphans'],",
    "  'left': F.leftover_markup('**粗体没收尾 H_{2'), 'ok': F.leftover_markup('**NiFeB_{0.33}**')}, ensure_ascii=False))",
  ].join("\n");
  const r = spawnSync(python, ["-c", code, dir], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = r.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(first), [["NiFeB", "n", true], ["0.33", "sub", true], ["-700", "n", true], [" η", "n", false], ["10", "sub", false]]);
  const o = JSON.parse(second);
  assert.ok(o.lines.every((l: string) => l.length > 0));
  assert.ok(!o.lines2.some((l: string) => l === "-1"), JSON.stringify(o.lines2));
  assert.ok(!o.lines3.some((l: string) => /^[）)]/.test(l)), JSON.stringify(o.lines3));
  if (o.cjk) assert.deepEqual(o.missing, []);
  assert.ok(o.left.length > 0);
  assert.deepEqual(o.ok, []);
});

test("科研原语与顶刊配色：贝塞尔弯曲/耦合箭头、自由能台阶/火山线/DOS 曲线、3D 径向球与晶格、胶囊卡片、引出线在 SVG 与 PPTX 双端可编辑", opts, () => {
  const spec = {
    name: "t",
    canvas: { width_mm: 183, height_mm: 110, purpose: "journal" },
    theme: { palette: "nature-reviews", base_pt: 6.5 },
    elements: [
      { id: "ch1", type: "chevron", x: 4, y: 4, w: 52, h: 9, fill: "primary", lead_in: false, text: "Stage I · Synthesis", color: "#FFFFFF", bold: true },
      { id: "card1", type: "header_card", x: 4, y: 16, w: 52, h: 38, gradient: ["primary@10", "#FFFFFF"], shadow: "soft",
        header: { text: "Interfacial Catalyst", fill: "primary" }, text: "Amorphous Ni cluster" },
      { id: "lat", type: "lattice", x: 8, y: 36, w: 28, h: 14, mode: "grid", nx: 4, ny: 2, bonds: true, vacancies: [[1, 0]], dopants: { "2,1": "accent" } },
      { id: "sp1", type: "sphere", x: 42, y: 38, w: 9, h: 9, fill: "accent", shadow: "soft" },
      { id: "rxn", type: "arrow", from: "card1", to: [96, 34], bend: 0.26, stroke: "accent", stroke_pt: 1.1, label: "H^{*}",
        coupled_in: [{ label: "H_{2}O + e^{-}", t: 0.32, side: -1 }],
        coupled_out: [{ label: "OH^{-}", t: 0.68, side: 1 }] },
      { id: "co1", type: "callout", x: 60, y: 6, w: 38, h: 9, target: [46.5, 42.5], stroke: "primary", text: "Active site" },
      { id: "dg", type: "energy_steps", x: 104, y: 4, w: 75, h: 32, fill: "panel_bg", box_stroke: "border",
        ylabel: "ΔG (eV)", xlabel: "Reaction coordinate", step_labels: ["H_{2}O^{*}", "TS", "H^{*}", "1/2 H_{2}"], smooth_ts: true,
        series: [{ label: "Ni/MoO_{2}", levels: [0, 0.36, -0.08, 0], color: "accent" }],
        barrier: { series: 0, step: 1, text: "0.36 eV" } },
      { id: "vol", type: "volcano_curve", x: 104, y: 40, w: 75, h: 32, fill: "panel_bg", fill_under: "primary@16",
        xlabel: "ΔG_{H*} (eV)", ylabel: "log |j| (mA cm^{-2})",
        markers: [{ x: -0.08, y: -0.15, label: "Ni/MoO_{2}", color: "accent" }] },
      { id: "dos", type: "dos_lobe", x: 4, y: 60, w: 94, h: 44, fill: "panel_bg",
        xlabel: "E - E_{F} (eV)", ylabel: "DOS (a.u.)",
        lobes: [{ center: -1.4, sigma: 0.7, amp: 0.85, color: "primary", label: "Mo 4d" }],
        d_centers: [{ x: -1.35, color: "accent", label: "ε_{d}" }] },
    ],
  };
  const root = project(spec);
  try {
    const r = run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx"]);
    assert.equal(r.status, 0, r.stderr);
    const svg = readFileSync(join(root, "figures/t/t.svg"), "utf8");
    assert.match(svg, /<radialGradient/);
    assert.match(svg, /<linearGradient/);
    assert.match(svg, /<feDropShadow/);
    assert.match(svg, /\bQ[\d., -]+/);
    assert.match(svg, /\bC[\d., -]+/);
    assert.doesNotMatch(svg, /stroke-linecap="[^"]*"[^>]*stroke-linecap=/);
    assert.match(svg, /DOS \(a\.u\.\)/);
    const xmlCheck = spawnSync(python, ["-c",
      "import sys, zipfile; from pptx import Presentation\np=Presentation(sys.argv[1]); assert len(p.slides[0].shapes) >= 15\ns=zipfile.ZipFile(sys.argv[1]).read('ppt/slides/slide1.xml').decode()\nprint(all(k in s for k in ('gradFill', 'outerShdw', 'quadBezTo', 'cubicBezTo')))",
      join(root, "figures/t/t.pptx")], { encoding: "utf8" });
    assert.equal(xmlCheck.status, 0, xmlCheck.stderr);
    assert.equal(xmlCheck.stdout.trim(), "True");

    const palList = run(root, "style_profile.py", ["--list-palettes"]);
    assert.equal(palList.status, 0, palList.stderr);
    assert.match(palList.stdout, /chem-rev-mineral/);
    const preset = run(root, "style_profile.py", ["--preset", "jacs-vibrant", "--out", "sp.json"]);
    assert.equal(preset.status, 0, preset.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, "sp.json"), "utf8")).theme.palette, "jacs-vibrant");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("三明治图层架构与检查放宽：hero_panel 归一化锚点、纯白留白区对比度放行、化学式/阶段号/坐标轴免检原文、GRAY-PAIR 单条合并", opts, () => {
  const root = mkdtempSync(join(tmpdir(), "hero-"));
  try {
    mkdirSync(join(root, "figures", "t", "assets"), { recursive: true });
    const mkHero = spawnSync(python, ["-c", [
      "import sys; from PIL import Image, ImageDraw",
      "im = Image.new('RGB', (1600, 1100), (255, 255, 255))",
      "d = ImageDraw.Draw(im); d.rounded_rectangle([380, 260, 1220, 860], radius=60, fill=(27, 79, 114))",
      "d.ellipse([680, 420, 920, 660], fill=(211, 84, 0))",
      "im.save(sys.argv[1])",
    ].join("\n"), join(root, "figures/t/assets/hero.png")], { encoding: "utf8" });
    assert.equal(mkHero.status, 0, mkHero.stderr);

    const hp = run(root, "asset_sheet.py", ["hero", "--subject", "Ni cluster on MoO2 terrace", "--palette", "nature-reviews"]);
    assert.equal(hp.status, 0, hp.stderr);
    assert.match(hp.stdout, /ABSOLUTELY WORDLESS/);
    writeFileSync(join(root, "figures/t/assets/hero.prompt.txt"), hp.stdout);

    const gr = run(root, "asset_sheet.py", ["grid", "figures/t/assets/hero.png", "--out", "figures/t/assets/hero-grid.jpg"]);
    assert.equal(gr.status, 0, gr.stderr);
    assert.ok(existsSync(join(root, "figures/t/assets/hero-grid.jpg")));

    const spec = {
      name: "t",
      canvas: { width_mm: 183, height_mm: 86, purpose: "journal" },
      theme: { palette: "nature-reviews", base_pt: 6.5 },
      elements: [
        { id: "hero", type: "hero_panel", x: 4, y: 4, w: 112, h: 78, src: "assets/hero.png",
          header: { text: "Stage I · Interfacial Catalysis", fill: "primary" },
          hero_margin_mm: [4, 3, 4, 4],
          anchors: { active: [0.50, 0.50], edge: [0.32, 0.55] },
          source: { kind: "image-model", model: "gemini-3-pro-image", prompt_file: "assets/hero.prompt.txt" } },
        // 文字落在 hero.png 顶角纯白留白区：对比度达标，不应误报 ONIMG / CROSS；高价离子电荷与晶相前缀免检原文
        { id: "eq", type: "text", x: 10, y: 14, w: 46, h: 6, text: "H_{2}O + e^{-} → H^{*} + OH^{-}", pt: 6.2, bold: true },
        { id: "ions", type: "text", x: 10, y: 21, w: 46, h: 6, text: "MoO_{4}^{2-} + Ni^{2+} → a-Ni/MoO_{2}", pt: 6.0 },
        { id: "axlbl", type: "text", x: 10, y: 28, w: 46, h: 6, text: "ΔG_{H*} (eV)", pt: 6.0 },
        { id: "co", type: "callout", x: 76, y: 14, w: 34, h: 8, target: "hero@active", stroke: "accent", text: "Ni-MoO_{2} interface" },
        { id: "sp", type: "arrow", from: "hero@edge", to: "hero@active", bend: 0.25, stroke: "accent", label: "H^{*}" },
        // 三块相近灰度的色块：应合并为最多 1 条 GRAY-PAIR，不刷屏
        { id: "g1", type: "box", x: 122, y: 6, w: 56, h: 16, fill: "#2E8B57", color: "#FFFFFF", text: "Alkaline HER" },
        { id: "g2", type: "box", x: 122, y: 26, w: 56, h: 16, fill: "#D35400", color: "#FFFFFF", text: "Interfacial Catalysis" },
        { id: "g3", type: "box", x: 122, y: 46, w: 56, h: 16, fill: "#2874A6", color: "#FFFFFF", text: "Ni-MoO_{2} interface" },
      ],
    };
    writeFileSync(join(root, "figures/t/figure.json"), JSON.stringify(spec));
    writeFileSync(join(root, "figures/t/brief.md"), "# 立意\nInterfacial Catalysis for Alkaline HER at Ni-MoO2 interface.\n");
    writeFileSync(join(root, "figures/t/facts.md"), "- Interfacial Catalysis\n- Alkaline HER\n- Ni-MoO2 interface\n");

    assert.equal(run(root, "render_figure.py", ["figures/t/figure.json", "--formats", "svg,pptx"]).status, 0);
    const chk = run(root, "schematic_check.py", ["figures/t/figure.json"]);
    assert.equal(chk.status, 0, chk.stdout + chk.stderr);
    const items = checks(root);
    assert.equal(items.filter((i) => i.status === "blocked").length, 0, JSON.stringify(items));
    assert.equal(items.filter((i) => i.id.startsWith("ONIMG-eq")).length, 0, JSON.stringify(items));
    assert.equal(items.filter((i) => i.id.startsWith("CROSS-")).length, 0, JSON.stringify(items));
    assert.equal(items.filter((i) => i.id.startsWith("GRAY-")).length, 1, JSON.stringify(items));
    assert.equal(items.find((i) => i.id.startsWith("GRAY-"))!.id, "GRAY-PAIR");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
