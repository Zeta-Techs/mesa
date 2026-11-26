import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 对话管理页列表稳定性（2026-11-26 用户：鼠标在列表上滑会自己往上跑，「更多」菜单点不出来在闪）
const src = readFileSync(new URL("../src/pages/SessionsPage.tsx", import.meta.url), "utf8");

test("选中行滚进视野只在换了哪一段时触发，不随 8 秒轮询换对象触发", () => {
  const at = src.indexOf("scrollIntoView({ block: \"nearest\" })");
  assert.ok(at > 0);
  const deps = src.slice(at, at + 200).match(/\}, \[([^\]]*)\]\);/)?.[1];
  assert.equal(deps, "selectedRowKey");
});

test("列表行首行定高，悬停换出 28px 操作钮时行高不变", () => {
  assert.match(src, /<div className="flex h-6 min-w-0 items-center gap-1\.5">/);
});
