import assert from "node:assert/strict";
import test from "node:test";
import { citeLabel, citeTipText, findCitations } from "../src/chat-cite.ts";

test("认 [@key]、[@a; @b]、[-@key, p. 3]；带前缀的、链接、脚注、邮箱不认（与 citation.rs 同口径）", () => {
  const text = "见 [@doe2020] 与 [@smith21; @lee:2022]，抑制 [-@hidden9, p. 33]。[cf. @a1] [@x](https://a) [^1] me@example.com";
  const hits = findCitations(text);
  assert.deepEqual(
    hits.map((h) => h.items.map((i) => i.key)),
    [["doe2020"], ["smith21", "lee:2022"], ["hidden9"]],
  );
  assert.deepEqual(hits[2]!.items[0], { key: "hidden9", suppressAuthor: true, locator: "p. 33" });
  for (const h of hits) assert.equal(text.slice(h.index, h.index + h.raw.length), h.raw);
});

test("胶囊上的字：一位 / 两位 / 多位作者、中文作者、抑制作者、没找到", () => {
  const item = (key: string, extra: Partial<{ suppressAuthor: boolean; locator: string | null }> = {}) => ({
    key,
    suppressAuthor: false,
    locator: null,
    ...extra,
  });
  const e = (authors: string[], year = "2020") => ({ key: "k", authors, year, title: "T" });
  assert.equal(citeLabel(e(["Smith"]), item("k")), "Smith 2020");
  assert.equal(citeLabel(e(["Smith", "Lee"]), item("k")), "Smith & Lee 2020");
  assert.equal(citeLabel(e(["Smith", "Lee", "Kim"]), item("k")), "Smith et al. 2020");
  assert.equal(citeLabel(e(["张三", "李四"]), item("k")), "张三等 2020");
  assert.equal(citeLabel(e(["Smith"]), item("k", { suppressAuthor: true, locator: "p. 3" })), "2020, p. 3");
  assert.equal(citeLabel(null, item("nope")), "@nope");
  assert.equal(citeTipText(e(["Smith", "Lee"])), "Smith、Lee · 2020\nT\n@k");
});
