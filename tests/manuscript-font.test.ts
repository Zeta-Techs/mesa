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
    assert.ok(text.includes("\\XeTeXgenerateactualtext=1"), "header 应带 ActualText 开关");
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

/** 不经 quarto，直接调脚本里的函数；表达式里用 m 代表脚本模块 */
const callScript = (expr: string, ...args: string[]) => {
  const r = spawnSync(
    python,
    [
      "-c",
      `import sys, importlib.util; sys.stdout.reconfigure(encoding='utf-8'); spec = importlib.util.spec_from_file_location('mf', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(${expr})`,
      script,
      ...args,
    ],
    { encoding: "utf8" },
  );
  return { ...r, stdout: (r.stdout ?? "").replace(/\r\n/g, "\n") };
};

const ACTUALTEXT = "\\ifdefined\\XeTeXgenerateactualtext\\XeTeXgenerateactualtext=1\\fi";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

test("字体脚本给 xelatex 补 ActualText：Times New Roman 下分号不再变成 U+037E", () => {
  // 新稿：booktabs 之后紧跟开关，缩进与上一行一致
  const fresh = callScript(
    "m.ensure_actualtext(m.ensure_booktabs(m.ensure_pdf(sys.argv[2])))",
    "title: D\nformat:\n  pdf:\n    pdf-engine: xelatex",
  );
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(fresh.stdout.includes(`\\usepackage{booktabs}\n        ${ACTUALTEXT}\n`), fresh.stdout);
  assert.equal(occurrences(fresh.stdout, ACTUALTEXT), 1);
  // 旧稿：已有 booktabs + parindent 但没有开关，重跑也补上；再跑一遍不重复
  const old =
    "title: D\nformat:\n  pdf:\n    include-in-header:\n      text: |\n        \\usepackage{booktabs}\n        \\usepackage{indentfirst}\n        \\setlength{\\parindent}{2em}\n    pdf-engine: xelatex";
  const patched = callScript("m.ensure_actualtext(m.ensure_booktabs(sys.argv[2]))", old);
  assert.equal(occurrences(patched.stdout, ACTUALTEXT), 1);
  const again = callScript("m.ensure_actualtext(m.ensure_booktabs(sys.argv[2]))", patched.stdout.trimEnd());
  assert.equal(occurrences(again.stdout, ACTUALTEXT), 1);
  // 守卫：\ifdefined 包住，换成 lualatex 也不会因未定义的控制序列报错
  assert.ok(ACTUALTEXT.startsWith("\\ifdefined") && ACTUALTEXT.endsWith("\\fi"));
});

const checkScript = resolve("src-tauri/resources/skills/quarto-render/scripts/check_pdf_text.py");
const hasPyMuPdf = spawnSync(python, ["-c", "import pymupdf"], { encoding: "utf8" }).status === 0;

test("PDF 码位抽检脚本：干净的 PDF 退出 0，打不开的文件退出 2，判定表点名 U+037E", { skip: !hasPyMuPdf }, () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-pdfcheck-"));
  try {
    const pdf = join(root, "ok.pdf");
    const made = spawnSync(
      python,
      ["-c", "import sys, pymupdf; d = pymupdf.open(); p = d.new_page(); p.insert_text((72, 72), 'Hello; world'); d.save(sys.argv[1])", pdf],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const clean = spawnSync(python, [checkScript, pdf], { encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const bad = join(root, "bad.pdf");
    writeFileSync(bad, "not a pdf");
    assert.equal(spawnSync(python, [checkScript, bad], { encoding: "utf8" }).status, 2);
    // 判定表本身：U+037E / U+FFFF / U+FFFD / 私有区都要点名，普通分号和字母不算
    const labels = spawnSync(
      python,
      [
        "-c",
        "import sys, importlib.util; spec = importlib.util.spec_from_file_location('c', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print([m.label(c) is not None for c in (0x37E, 0xFFFF, 0xFFFD, 0xE001, 0x3B, 0x41)])",
        checkScript,
      ],
      { encoding: "utf8" },
    );
    assert.equal(labels.stdout.trim(), "[True, True, True, True, False, False]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
