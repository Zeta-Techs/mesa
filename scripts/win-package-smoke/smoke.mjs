// 打包版自动点验：在新用户沙盒里跑打好的 Mesa（scripts/dev-sandbox.sh --app … --debug-port 9333），
// 经 WebView2 远程调试把首次打开、各页面、各类文件的打开、各套主题逐个走一遍，收集页面报错 / 「界面渲染出错」/ CSP 拦截，
// 每步截图。只点不改：不发消息、不装东西、不碰真实数据（沙盒家目录里的样例项目除外）。
//
// 用法：node scripts/win-package-smoke/smoke.mjs --port 9333 --project <样例项目目录> --out <结果目录>
// 结果：<out>/report.json（每步结果与收集到的报错）+ <out>/*.png（截图），终端打印摘要；有失败退出码 1。
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { connect } from "./cdp.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const port = Number(arg("port", "9333"));
const project = arg("project");
const out = arg("out", "smoke-out");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await connect(port, { waitMs: 90_000 });
await c.send("Runtime.enable");
await c.send("Log.enable");
await c.send("Page.enable");

// ===== 报错收集：页面异常、console.error、浏览器日志里的错误（CSP 拦截在这里） =====
const errors = [];
let step = "启动";
const pushErr = (kind, text) => errors.push({ step, kind, text: String(text).slice(0, 2000) });
c.on("Runtime.exceptionThrown", (p) =>
  pushErr("exception", p.exceptionDetails.exception?.description ?? p.exceptionDetails.text),
);
c.on("Runtime.consoleAPICalled", (p) => {
  if (p.type !== "error" && p.type !== "assert") return;
  pushErr("console.error", p.args.map((a) => a.value ?? a.description ?? "").join(" "));
});
c.on("Log.entryAdded", (p) => {
  if (p.entry.level === "error") pushErr(`log:${p.entry.source}`, `${p.entry.text} ${p.entry.url ?? ""}`);
});

// ===== 页面里的小工具 =====
const page = {
  text: () => c.evaluate("document.body.innerText"),
  /** 按可见文字 / aria-label / title 开头找可点的元素并点它；找不到返回 false */
  click: (label) =>
    c.evaluate(`(() => {
      const want = ${JSON.stringify(label)};
      const els = [...document.querySelectorAll('button, [role=button], a, [role=tab], [role=menuitem], [title], [aria-label]')];
      const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const hit = els.find((e) => visible(e) && (e.innerText?.trim() === want || e.getAttribute('aria-label') === want))
        ?? els.find((e) => visible(e) && (e.getAttribute('title') ?? '').startsWith(want));
      if (!hit) return false;
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return true;
    })()`),
  key: async (key, code, vk, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"])
      await c.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, modifiers });
  },
  shot: async (name) => {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    const file = join(out, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  },
};

const results = [];
let shotSeq = 0;
/** 一步走完后的检查：有没有整页崩、这一步新增了哪些报错；崩了点「尝试恢复」 */
async function check(name, extra = {}) {
  await sleep(extra.wait ?? 1500);
  const body = await page.text();
  const crashed = body.includes("界面渲染出错");
  // 预览区读取失败（PreviewErrorState）：红字「无法预览这个…」+ 原因
  const previewError = /无法预览这个/.test(body)
    ? await c.evaluate("[...document.querySelectorAll('p')].find((p) => p.innerText.startsWith('无法预览这个'))?.parentElement?.innerText ?? ''")
    : null;
  const stepErrors = errors.filter((e) => e.step === step);
  const shot = await page.shot(`${String(++shotSeq).padStart(2, "0")}-${name.replace(/[\\/:*?"<>| ]+/g, "_")}`);
  let crashText = null;
  if (crashed) {
    crashText = await c.evaluate("document.querySelector('pre')?.innerText ?? ''");
    await page.click("尝试恢复");
    await sleep(800);
  }
  const r = { step: name, ok: !crashed && !previewError && stepErrors.length === 0, crashed, crashText, previewError, errors: stepErrors, shot, ...extra.info };
  results.push(r);
  console.log(`${r.ok ? "✓" : "✗"} ${name}${crashed ? "  【界面渲染出错】" : ""}${previewError ? "  【无法预览】" : ""}${stepErrors.length ? `  报错 ${stepErrors.length} 条` : ""}`);
  return r;
}

// ===== 1. 第一次打开 =====
await c.evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('#root')?.children.length) { clearInterval(t); ok(); } }, 200); })`);
await sleep(4000);
const firstText = await page.text();
await check("第一次打开", { wait: 0, info: { onboarding: firstText.includes("稍后再说"), excerpt: firstText.slice(0, 400) } });
step = "收起上手向导";
const dismissed = await page.click("稍后再说");
await check("收起上手向导", { info: { dismissed } });

// ===== 2. 侧栏各页 =====
const PAGES = [
  ["工作台", "1", "Digit1", 49],
  ["对话管理", "2", "Digit2", 50],
  ["项目", "3", "Digit3", 51],
  ["连接", "4", "Digit4", 52],
  ["技能", "5", "Digit5", 53],
  ["MCP", "6", "Digit6", 54],
  ["用量", "7", "Digit7", 55],
  ["设置", "8", "Digit8", 56],
];
for (const [name, key, code, vk] of PAGES) {
  step = `页面：${name}`;
  await page.key(key, code, vk, 2);
  await check(step, { wait: 2500 });
}
step = "页面：运行";
await page.click("运行");
await check(step, { wait: 2500 });

// ===== 3. 样例项目里逐个打开文件 =====
if (project) {
  step = "登记样例项目";
  const reg = await c
    .evaluate(`window.__TAURI_INTERNALS__.invoke('register_project', { path: ${JSON.stringify(project)}, name: '点验项目' }).then(() => 'ok', (e) => String(e))`)
    .catch((e) => String(e));
  await check(step, { info: { register: reg } });

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.startsWith(".")) continue;
      statSync(p).isDirectory() ? walk(p) : files.push(relative(project, p).split(sep).join("/"));
    }
  };
  walk(project);
  results.push({ step: "样例文件", files });
  // 项目页「文件」：目录行是带 aria-expanded 的按钮，文件行是带 data-file-path（绝对路径）的按钮，点了在右边预览
  await c.evaluate("location.reload()");
  await sleep(5000);
  await page.click("去项目页：");
  await sleep(2000);
  await page.click("文件");
  await sleep(2000);
  const openFile = (rel) =>
    c.evaluate(`(async () => {
      const rel = ${JSON.stringify(rel)};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const segs = rel.split('/');
      for (const seg of segs.slice(0, -1)) {
        const dir = [...document.querySelectorAll('button[aria-expanded]')].find((b) => b.innerText.split('\\n')[0].trim() === seg);
        if (dir && dir.getAttribute('aria-expanded') === 'false') { dir.click(); await sleep(600); }
      }
      const norm = (p) => p.replace(/\\\\/g, '/');
      const file = [...document.querySelectorAll('button[data-file-path]')].find((b) => norm(b.dataset.filePath).endsWith('/' + rel));
      if (!file) return false;
      file.scrollIntoView({ block: 'center' });
      file.click();
      return true;
    })()`);
  for (const f of files) {
    step = `打开文件：${f}`;
    const opened = await openFile(f);
    await check(step, { wait: 2500, info: { opened } });
  }

  // ===== 4. 各套主题下打开代码与 Markdown（编辑器跟主题重新上色那条路） =====
  const themes = await c.evaluate(`[...new Set([...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .map((r) => /\\[data-theme="([^"]+)"\\]/.exec(r.selectorText ?? '')?.[1]).filter(Boolean))]`);
  for (const t of ["", ...themes]) {
    step = `主题：${t || "默认"}`;
    await c.evaluate(`(() => { const el = document.documentElement; ${t ? `el.dataset.theme = ${JSON.stringify(t)}` : "delete el.dataset.theme"}; })()`);
    for (const f of ["src/main.ts", "README.md"]) await openFile(f);
    await check(step, { wait: 1500, info: { theme: t || "默认" } });
  }
}

writeFileSync(join(out, "report.json"), JSON.stringify({ results, errors }, null, 2));
const failed = results.filter((r) => r.ok === false);
console.log(`\n共 ${results.filter((r) => r.ok !== undefined).length} 步，失败 ${failed.length} 步；报错 ${errors.length} 条。结果：${join(out, "report.json")}`);
c.close();
process.exit(failed.length ? 1 : 0);
