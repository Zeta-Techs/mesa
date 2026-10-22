#!/usr/bin/env node
/**
 * `npm run canary` 的入口（三平台同一个写法）：找一个真能跑的 Python 3，再把参数原样交给 canary.py。
 * macOS 上是 python3；Windows 上 PATH 里第一个 python 可能是应用商店的占位程序（一跑就退出），挨个试到能跑的那个。
 *
 *   npm run canary                              九家都跑，和基线比
 *   npm run canary -- --accept                  看过报告、Mesa 也改好了：记成新基线
 *   npm run canary -- --accept-unchanged        只是版本往前走、指纹没变：只挪核对版本
 *   npm run canary -- --agents claude-code      只跑这几家
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];

function works(cmd) {
  const args = cmd === "py" ? ["-3", "--version"] : ["--version"];
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false });
  return r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`);
}

const python = candidates.find(works);
if (!python) {
  console.error("找不到能跑的 Python 3（试过：" + candidates.join("、") + "）。装好 Python 3 再来。");
  process.exit(2);
}
const pre = python === "py" ? ["-3"] : [];
const r = spawnSync(python, [...pre, "-I", "-X", "utf8", join(here, "canary.py"), ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: false,
});
process.exit(r.status ?? 2);
