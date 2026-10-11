import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SETTINGS_SEARCH_INDEX,
  searchSettings,
} from "../src/settings-search.ts";

/**
 * 设置页搜索。
 *
 * 索引与 SettingsPage 的 SETTING_NAV 是两份数据，没有任何东西保证它们还对得上，
 * 所以最后一条测试直接从 SettingsPage.tsx 源文件里抠出 SETTING_NAV 的 id 比对。
 */

test("查询为空时返回全部档位，顺序即界面顺序", () => {
  const all = searchSettings("");
  assert.equal(all.length, SETTINGS_SEARCH_INDEX.length);
  assert.deepEqual(
    all.map((e) => e.id),
    SETTINGS_SEARCH_INDEX.map((e) => e.id),
  );
  // 纯空白也算空查询，不能把整页搜没
  assert.equal(searchSettings("   ").length, SETTINGS_SEARCH_INDEX.length);
});

test("搜档名直接命中该档", () => {
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.equal(
      searchSettings(entry.label)[0]?.id,
      entry.id,
      `搜「${entry.label}」没有落到 ${entry.id}`,
    );
  }
});

test("搜界面上不出现的词也能落到对档", () => {
  // 这几条是索引存在的理由：词在行标签里一个都没有
  const cases: [string, string][] = [
    ["代理", "network"],
    ["proxy", "network"],
    ["卡顿", "appearance"],
    ["字体大小", "appearance"],
    ["滚动缓冲", "appearance"],
    ["开机自启", "startup"],
    ["汇率", "stats"],
    ["余额", "stats"],
    ["外部终端", "integration"],
    ["自动命名", "integration"],
    ["起名", "integration"],
    ["会话标题", "integration"],
    ["依赖体检", "diag"],
    ["导出", "storage"],
    ["项目目录", "storage"],
  ];
  for (const [query, expected] of cases) {
    assert.equal(
      searchSettings(query)[0]?.id,
      expected,
      `搜「${query}」没有落到 ${expected}`,
    );
  }
});

test("大小写与首尾空白不影响结果", () => {
  assert.deepEqual(
    searchSettings("PROXY").map((e) => e.id),
    searchSettings("  proxy  ").map((e) => e.id),
  );
});

test("档名命中排在别名命中之前", () => {
  // 「网络」既是档名，也可能出现在别的档别名里；档名那一档必须第一
  assert.equal(searchSettings("网络")[0]?.id, "network");
  assert.equal(searchSettings("统计")[0]?.id, "stats");
});

test("搜不到的词返回空数组，而不是回落成全部", () => {
  // 回落成全部会让「无结果」提示永远不出现，等于搜索没生效
  assert.deepEqual(searchSettings("zzzz-不存在的词"), []);
});

test("索引与 SettingsPage 的 SETTING_NAV 保持同步", () => {
  const src = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  const nav = /const SETTING_NAV[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  assert.ok(nav, "没找到 SETTING_NAV，设置页结构变了");
  const ids = [...nav[1].matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 5, `只抠到 ${ids.length} 个分区 id，正则可能失效了`);
  assert.deepEqual(
    SETTINGS_SEARCH_INDEX.map((e) => e.id).slice().sort(),
    ids.slice().sort(),
    "搜索索引与设置页分区对不上——加了分区没进索引，或者索引里有已删的档",
  );
});

test("每档都有别名，且没有空别名", () => {
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.ok(entry.aliases.length > 0, `${entry.id} 没有别名，等于只能按档名搜`);
    for (const a of entry.aliases) {
      assert.ok(a.trim(), `${entry.id} 里有空别名`);
    }
  }
});
