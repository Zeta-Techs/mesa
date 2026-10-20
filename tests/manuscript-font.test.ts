import assert from "node:assert/strict";
import test from "node:test";
import { manuscriptFontPrompt } from "../src/manuscript-font.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
const zipXml = (docx: string) =>
  spawnSync(
    python,
    ["-c", "import sys; sys.stdout.reconfigure(encoding='utf-8'); import zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read('word/styles.xml').decode())", docx],
    { encoding: "utf8" },
  );

const script = resolve("src-tauri/resources/skills/quarto-render/scripts/manuscript_font.py");

/** `quarto --version` 输出版本号才算能用（与 dep_check.rs quarto_status 同口径） */
const quartoWorks = () => /\d/.test(spawnSync("quarto", ["--version"], { encoding: "utf8" }).stdout ?? "");

/** 不经 quarto，直接调脚本的 YAML 改写函数。Windows 上 Python 的 print 会把 \n 写成 \r\n，统一还原再断言 */
const rewriteYaml = (front: string, reference = "reference.docx") => {
  const r = spawnSync(
    python,
    [
      "-c",
      "import sys, importlib.util; sys.stdout.reconfigure(encoding='utf-8'); spec = importlib.util.spec_from_file_location('mf', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(m.ensure_docx_reference(m.ensure_pdf(sys.argv[2]), sys.argv[3]))",
      script,
      front,
      reference,
    ],
    { encoding: "utf8" },
  );
  return { ...r, stdout: (r.stdout ?? "").replace(/\r\n/g, "\n") };
};

test("确认字体的提示同时改 PDF 和 Word", () => {
  const ask = manuscriptFontPrompt("manuscript/draft.md", "Times New Roman", "宋体");
  assert.match(ask, /Times New Roman/);
  assert.match(ask, /宋体/);
  assert.match(ask, /reference-doc/);
  assert.match(ask, /manuscript\/reference\.docx/);
  assert.match(ask, /manuscript_font\.py/);
  assert.match(ask, /不要先渲完再重渲/);
  assert.doesNotMatch(ask, /然后重渲/);
});

test("初稿字体写入 YAML：英文新罗马，中文宋体", () => {
  // 指定一个本机真有的中文宋体：脚本找得到 fc-list 时会核对字体在不在（Windows 上 TinyTeX 自带 fc-list）
  const cjkFont = process.platform === "win32" ? "SimSun" : "Songti SC";
  const root = mkdtempSync(join(tmpdir(), "mesa-font-"));
  try {
    mkdirSync(join(root, "manuscript"));
    const md = join(root, "manuscript/draft.md");
    writeFileSync(
      md,
      "---\ntitle: Draft\nformat:\n  pdf:\n    pdf-engine: xelatex\n    mainfont: \"TeX Gyre Termes\"\n---\n\n正文。\n",
    );
    const result = spawnSync(
      python,
      [script, "--root", root, "--markdown", "manuscript/draft.md", "--latin", "Times New Roman", "--cjk", cjkFont],
      { encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status !== 0 && /quarto not found|本机没有 quarto/.test(output)) return;
    // 装了但跑不起来的 quarto（如 conda 里缺 deno 的壳）同样视作本机没有，不算脚本失败
    if (result.status !== 0 && !quartoWorks()) return;
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(md, "utf8");
    assert.match(text, /mainfont: "Times New Roman"/);
    assert.match(text, new RegExp(`CJKmainfont: "${cjkFont}"`));
    assert.match(text, /booktabs/);
    assert.match(text, /parindent\}\{2em\}/);
    assert.match(readFileSync(join(root, "manuscript/typeface.md"), "utf8"), /英文：Times New Roman/);
    // Word 主题的标题/正文字体槽真的换过（2026-10-18：旧写法从没生效，Word 一直是 Aptos / 等线）
    const theme = spawnSync(
      python,
      ["-c", "import sys; sys.stdout.reconfigure(encoding='utf-8'); import zipfile; print(zipfile.ZipFile(sys.argv[1]).read('word/theme/theme1.xml').decode())", join(root, "manuscript/reference.docx")],
      { encoding: "utf8" },
    );
    assert.match(theme.stdout, /<a:latin typeface="Times New Roman"\/>/);
    assert.match(theme.stdout, new RegExp(`<a:ea typeface="${cjkFont}"/>`));
    assert.doesNotMatch(theme.stdout, /typeface="Aptos/);
    const styles = zipXml(join(root, "manuscript/reference.docx"));
    assert.match(styles.stdout, /Heading1/);
    assert.match(styles.stdout, /outlineLvl w:val="0"/);
    assert.match(styles.stdout, /firstLineChars="200"/);
    assert.match(styles.stdout, /w:line="360"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("字体脚本把 reference-doc 写进 YAML 的 format.docx：任何入口出 Word 都套模板", () => {
  const added = rewriteYaml("title: Draft\nformat:\n  pdf:\n    pdf-engine: xelatex");
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /\n  docx:\n    reference-doc: reference\.docx/);
  // `docx: default` 标量改成映射再挂参数
  const scalar = rewriteYaml("title: D\nformat:\n  docx: default\n  pdf:\n    pdf-engine: xelatex");
  assert.match(scalar.stdout, /\n  docx:\n    reference-doc: reference\.docx\n  pdf:/);
  // 人已写的 reference-doc 不动
  const kept = rewriteYaml("title: D\nformat:\n  docx:\n    reference-doc: custom.docx\n  pdf:\n    pdf-engine: xelatex");
  assert.match(kept.stdout, /reference-doc: custom\.docx/);
  assert.doesNotMatch(kept.stdout, /reference-doc: reference\.docx/);
});

test("Word 主题字体槽按闭合标签整段替换（不依赖 quarto）", () => {
  const theme =
    '<a:fontScheme><a:majorFont><a:latin typeface="Aptos Display" panose="1"/><a:ea typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme>';
  const out = spawnSync(
    python,
    [
      "-c",
      "import sys, importlib.util; sys.stdout.reconfigure(encoding='utf-8'); spec = importlib.util.spec_from_file_location('mf', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(m.theme_fonts(sys.argv[2], 'Times New Roman', '宋体'))",
      script,
      theme,
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.match(/<a:latin typeface="Times New Roman"\/>/g)?.length, 2);
  assert.equal(out.stdout.match(/typeface="宋体"/g)?.length, 4);
  assert.doesNotMatch(out.stdout, /Aptos|等线/);
});
