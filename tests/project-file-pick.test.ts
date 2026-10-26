import assert from "node:assert/strict";
import test from "node:test";
import { fileDateLabel, filesOnly, folderOf, toggleSelected } from "../src/project-file-pick.ts";

test("行内时间：今年写月日时分，往年写年月日，读不到写空", () => {
  const now = new Date(2026, 9, 26, 12, 0);
  assert.equal(fileDateLabel(new Date(2026, 9, 25, 1, 49).toISOString(), now), "10月25日 1:49");
  assert.equal(fileDateLabel(new Date(2025, 2, 3, 9, 5).toISOString(), now), "2025年3月3日");
  assert.equal(fileDateLabel(null, now), "");
  assert.equal(fileDateLabel("不是时间", now), "");
});

test("所在文件夹：根下的文件不写", () => {
  assert.equal(folderOf("figures/cover.png"), "figures");
  assert.equal(folderOf("a/b/c.md"), "a/b");
  assert.equal(folderOf("data.csv"), "");
});

test("搜索结果只留文件，Windows 分隔符统一成 /", () => {
  const out = filesOnly([
    { path: "C:\\p\\src", name: "src", rel: "src", isDir: true },
    { path: "C:\\p\\src\\main.rs", name: "main.rs", rel: "src\\main.rs", isDir: false, modified: "2026-10-01T00:00:00Z" },
  ]);
  assert.deepEqual(out, [{ path: "C:\\p\\src\\main.rs", name: "main.rs", rel: "src/main.rs", modified: "2026-10-01T00:00:00Z" }]);
});

test("勾选：按点的先后排，再点一次去掉", () => {
  assert.deepEqual(toggleSelected(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleSelected(["a", "b"], "a"), ["b"]);
});
