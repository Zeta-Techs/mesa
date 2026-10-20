import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * zustand 5 的选择器结果按引用比较：选择器里写 `?? []` / `?? {}` / `|| []`，字段为空时每次都给
 * 新对象，组件一挂载就无限重渲染（Maximum update depth exceeded）。2026-10-19 Windows 实证：
 * 设置里 hiddenProfiles 为 null，项目页三个组件同时中招，应用起不来。缺省值必须是模块级常量
 * （见 store.ts selectHiddenProfiles）。
 */
const root = new URL("../src/", import.meta.url);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test("store 选择器里不写会每次新建对象的缺省值", () => {
  const offenders: string[] = [];
  const selector = /use[A-Z]\w*Store\(\s*\(\s*\w+\s*\)\s*=>([\s\S]*?)\)\s*;/g;
  const fresh = /(\?\?|\|\|)\s*(\[\s*\]|\{\s*\}|new\s+(Set|Map|Array)\b)/;
  for (const file of walk(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(selector)) {
      if (fresh.test(m[1])) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file}:${line}: ${m[1].replace(/\s+/g, " ").trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `选择器缺省值要用模块级常量：\n${offenders.join("\n")}`);
});
