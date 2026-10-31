import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 令牌纪律的可执行闸门。
 *
 * 教训来自盘点：有测试背书的禁令（`.ccode-well` 卡片、浅色浮起梯度）违规数为 0，
 * 只写在文档里的禁令则成规模泄漏——`text-[Npx]` 34 处、`rounded-[Npx]` 4 处，
 * 分布 6–8 个文件。文档没人守着，测试有人守着，所以把禁令搬进测试。
 *
 * 扫描对象是源码文本而非 AST：这两类违反只可能出现在 className 字面量里，
 * 正则足够，且能同时覆盖模板字符串（`${...}` 插值里的类名 AST 反而更难取）。
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** 递归收集 src 下的 .ts/.tsx；跳过测试与外部参考代码 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC);
const rel = (f: string) => f.slice(SRC.length + 1);

/** 行号 + 原文，报错时能直接跳过去 */
function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        re.lastIndex = 0;
        if (re.test(line)) found.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

test("扫描范围非空（防止路径写错导致永久空跑）", () => {
  assert.ok(FILES.length > 50, `只扫到 ${FILES.length} 个源文件，路径不对`);
});

test("禁用 text-[Npx] 任意字号，一律走 text-micro/xs/sm/base", () => {
  const found = hits(/text-\[\d+px\]/);
  assert.deepEqual(
    found,
    [],
    `字号必须走令牌（design-system.md「字号阶梯令牌化」）；` +
      `micro=11px 是可读下限，要更小说明该改用颜色弱化：\n${found.join("\n")}`,
  );
});

test("rounded-[Npx] 只允许 ≤4px 的微标记，且仅限 ≤14px 的图标/装饰", () => {
  // 5px 的最紧令牌会把 6–9px 的斜块/菱形磨圆到变形，故 1px 例外；
  // 14px 的 provider 图标取 3px、16px 勾选框取 4px。判据是尺寸与用途，不是文件位置。
  const allowed = [
    "components/ProjectGroup.tsx", // 步进器 1px 斜块 / 菱形
  ];
  const found = hits(/rounded-\[\d+(?:\.\d+)?px\]/);
  const extra = found.filter(
    (h) => !allowed.some((a) => h.startsWith(a)) || /rounded-\[[5-9]|\d{2,}px\]/.test(h),
  );
  assert.deepEqual(
    extra,
    [],
    `圆角超额：仅 ≤4px 的微标记可写死值，其余走 rounded-sm/md/lg：\n${extra.join("\n")}`,
  );
  // 豁免清单本身不得腐烂：三个文件都还在用，删了元素就该把这里一起删
  for (const file of allowed) {
    assert.ok(
      found.some((h) => h.startsWith(file)),
      `${file} 不再有微圆角写法了，请从豁免清单移除`,
    );
  }
});
