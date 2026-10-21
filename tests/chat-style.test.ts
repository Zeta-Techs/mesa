import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHAT_ACCENTS,
  CHAT_FONT_FAMILIES,
  CHAT_FONT_SIZES,
  CHAT_SCROLLBARS,
  chatFontFamilyStack,
  chatFontSizePx,
  chatStyleVars,
  normalizeChatAccent,
  normalizeChatFontSize,
  normalizeChatScrollbar,
} from "../src/chat-style.ts";

const rust = readFileSync(
  new URL("../src-tauri/src/settings.rs", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/* Rust 白名单不跟前端，现象是「选了没反应」：逐表钉住 */
function rustTable(name: string): string[] {
  const m = rust.match(new RegExp(`const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`));
  assert.ok(m, `settings.rs 缺 ${name}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("前端各表与 Rust 白名单一致", () => {
  assert.deepEqual(rustTable("KNOWN_CHAT_FONT_SIZES"), [...CHAT_FONT_SIZES]);
  assert.deepEqual(rustTable("KNOWN_CHAT_FONT_FAMILIES"), [...CHAT_FONT_FAMILIES]);
  assert.deepEqual(rustTable("KNOWN_CHAT_ACCENTS"), [...CHAT_ACCENTS]);
  assert.deepEqual(rustTable("KNOWN_CHAT_SCROLLBARS"), [...CHAT_SCROLLBARS]);
});

test("没调过：不写任何内联变量，保证与改版前同一个样子", () => {
  assert.deepEqual(chatStyleVars({}), {});
  assert.deepEqual(
    chatStyleVars({ chatFontSize: "normal", chatFontFamily: "system" }),
    {},
  );
});

test("非法值落回默认", () => {
  assert.equal(normalizeChatFontSize("huge"), "normal");
  assert.equal(normalizeChatAccent("neon"), "warm");
  assert.equal(normalizeChatScrollbar(undefined), "auto");
  assert.equal(chatFontSizePx("huge"), null);
  assert.equal(chatFontFamilyStack("comic"), null);
});

test("字号档递增，衬线栈中文衬线在前", () => {
  const px = (["small", "normal", "large", "xlarge"] as const).map((k) =>
    chatFontSizePx(k),
  );
  assert.equal(px[1], null);
  assert.ok(px[0]! < 13.5 && px[2]! > 14 && px[3]! > px[2]!);
  const serif = chatFontFamilyStack("serif")!;
  assert.ok(serif.indexOf("Songti SC") < serif.indexOf("Georgia"));
  assert.deepEqual(chatStyleVars({ chatFontSize: "large", chatFontFamily: "mono" }), {
    "--ccode-chat-fs": "15.5px",
    "--ccode-chat-ff": "var(--font-mono)",
  });
});

test("CSS：每个强调色深浅各一套，且气泡与正文都读同一组变量", () => {
  for (const a of CHAT_ACCENTS.filter((x) => x !== "off")) {
    assert.ok(css.includes(`--chat-code-dark-${a}`), `缺深色 ${a}`);
    assert.ok(css.includes(`--chat-code-light-${a}`), `缺浅色 ${a}`);
    assert.ok(css.includes(`data-chat-accent="${a}"`), `缺选择器 ${a}`);
  }
  assert.ok(css.includes(".ccode-chat-user"));
  assert.ok(css.includes("var(--ccode-chat-fs"));
  assert.ok(css.includes(".ccode-chat-scroll"));
});
