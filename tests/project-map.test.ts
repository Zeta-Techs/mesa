import assert from "node:assert/strict";
import test from "node:test";
import { formatSize, MAP_FOLD_SHOW, renderProjectMap, type MapEntry } from "../src/project-map.ts";

const day = (d: number) => Date.UTC(2026, 10, d, 4);

test("项目地图：小目录逐个列，大目录折成摘要只列最新几个，上次问以来改过的标「新」", () => {
  const entries: MapEntry[] = [
    { path: "lab/2026-11-01.md", size: 900, modifiedMs: day(1) },
    { path: "lab/2026-11-04.md", size: 1200, modifiedMs: day(4) },
    ...Array.from({ length: 12 }, (_, i) => ({ path: `data/raw/s${String(i).padStart(2, "0")}.csv`, size: 2048, modifiedMs: day(1) + i })),
    { path: "README.md", size: 10, modifiedMs: day(2) },
  ];
  const text = renderProjectMap(entries, { sinceMs: day(3) });
  assert.match(text, /^共 15 个文件/);
  assert.match(text, /最近改动（上次问我以来新出现或改过 1 个，标「新」）：\n- lab\/2026-11-04\.md  1\.2 KB · 2026-11-04 · 新/);
  assert.match(text, /data\/raw\/（12 个文件、24 KB；csv×12；最近改在 2026-11-01；下面只列最新 3 个）\n  s11\.csv/);
  assert.equal((text.match(/  s\d\d\.csv/g) ?? []).length, MAP_FOLD_SHOW, "大目录只列最新几个（最近改动一节写的是全路径）");
  assert.match(text, /（项目根）\n  README\.md/);
  assert.match(text, /lab\/\n  2026-11-01\.md/);
});

test("项目地图：没文件、没列完、太长截断", () => {
  assert.match(renderProjectMap([]), /还没有文件/);
  assert.match(renderProjectMap([{ path: "a", size: 1, modifiedMs: 0 }], { truncated: true }), /太多没列完/);
  const many = Array.from({ length: 300 }, (_, i) => ({ path: `d${i}/f.txt`, size: 1, modifiedMs: day(1) }));
  const text = renderProjectMap(many, { maxChars: 2000 });
  assert.ok(text.length <= 2100);
  assert.match(text, /地图太长/);
  assert.ok(!/新/.test(renderProjectMap([{ path: "a", size: 1, modifiedMs: day(5) }])), "没问过不标新");
});

test("文件大小写法", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});
