import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readScreen, type ScreenFixture } from "../scripts/screen-corpus/corpus.ts";

/**
 * 抓屏语料库回归（tests/fixtures/screens/README.md）：每份样本是某家 CLI 某版本的一屏真实画面，
 * Mesa 的读屏解析器读出来要和存下的一样。改解析器把老画面读坏了，这里会红。
 */
const ROOT = join("tests", "fixtures", "screens");
const files = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        readdirSync(join(ROOT, d.name))
          .filter((f) => f.endsWith(".json"))
          .map((f) => join(ROOT, d.name, f)),
      )
  : [];

test("抓屏语料库不空", () => {
  assert.ok(files.length > 0, "tests/fixtures/screens 下还没有样本");
});

for (const file of files) {
  test(`读屏回归：${file}`, () => {
    const fx = JSON.parse(readFileSync(file, "utf8")) as ScreenFixture;
    const keys = Object.keys(fx.expect) as (keyof ScreenFixture["expect"])[];
    assert.ok(keys.length > 0, "样本至少核对一项");
    assert.deepEqual(readScreen(fx.agent, fx.rows, keys), fx.expect, fx.note);
  });
}
