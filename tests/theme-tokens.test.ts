import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { THEMES } from "../src/themes.ts";

/**
 * 跨文件主题令牌一致性。
 *
 * 终端底色/前景写在 TerminalPage 的 XTERM_BG_FG 里——xterm 画在 canvas 上，
 * 读不了 CSS 变量，所以这份字面量是必要的重复。重复就会漂移：这份表曾经
 * 注释说「取自 App.css」但浅色七行其实各不相等，且只靠
 * `XTERM_BG_FG[themeId] ?? XTERM_BG_FG.midnight` 兜底——加一套新主题不会报错，
 * 只会静默套上沉浸黑的配色。这里把两件事都钉死：
 *   1) 每套主题都必须有自己的行（堵住静默兜底）；
 *   2) 深色行与 App.css 的 --color-editor-bg/-fg 逐字一致（堵住漂移）；
 *   3) 深色行的底色等于该主题的 --color-canvas（2026-10-22：终端与聊天层同底，切层不跳色）。
 * 浅色行**故意不等同** editor-bg（纯白整屏当终端刺眼），故只校验方向：近白、且前景够深。
 */
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../src/pages/TerminalPage.tsx", import.meta.url),
  "utf8",
);

/** 每个主题块的 --color-editor-bg / --color-editor-fg；沉浸黑在 @theme */
function editorTokens(themeId: string | null): { bg: string; fg: string } {
  const body =
    themeId === null
      ? /@theme\s*\{(.*?)\n\}/s.exec(css)?.[1]
      : new RegExp(
          `(?:^|\\n)\\[data-theme="${themeId}"\\]\\s*\\{([^]*?)\\n\\}`,
        ).exec(css)?.[1];
  assert.ok(body, `找不到主题块 ${themeId ?? "@theme"}`);
  const bg = /--color-editor-bg:\s*(#[0-9a-fA-F]{6})/.exec(body)?.[1];
  const fg = /--color-editor-fg:\s*(#[0-9a-fA-F]{6})/.exec(body)?.[1];
  assert.ok(bg && fg, `${themeId ?? "@theme"} 缺 editor-bg/editor-fg`);
  return { bg: bg.toLowerCase(), fg: fg.toLowerCase() };
}

/** 从源码文本解析 XTERM_BG_FG 表；每条目一行，形状固定 */
function xtermTable(): Record<string, { bg: string; fg: string }> {
  const start = page.indexOf("const XTERM_BG_FG");
  assert.ok(start > 0, "找不到 XTERM_BG_FG 定义");
  const end = page.indexOf("\n  };", start);
  assert.ok(end > start, "找不到 XTERM_BG_FG 结束位置（缩进变了？）");
  const out: Record<string, { bg: string; fg: string }> = {};
  for (const m of page
    .slice(start, end)
    .matchAll(
      /("?)([a-z][a-z-]*)\1:\s*\{\s*background:\s*"(#[0-9a-fA-F]{6})",\s*foreground:\s*"(#[0-9a-fA-F]{6})"/g,
    )) {
    out[m[2]] = { bg: m[3].toLowerCase(), fg: m[4].toLowerCase() };
  }
  assert.ok(
    Object.keys(out).length > 0,
    "XTERM_BG_FG 一条都没解析出来（格式变了，改这个测试而不是绕过它）",
  );
  return out;
}

/** 感知亮度，只用来判「够不够白」 */
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const TABLE = xtermTable();

test("十四套主题在 XTERM_BG_FG 里都有自己的行", () => {
  const missing = THEMES.filter((t) => !TABLE[t.id]).map((t) => t.id);
  assert.deepEqual(
    missing,
    [],
    `这些主题没有终端配色行，会静默套用默认主题那行（?? XTERM_BG_FG[DEFAULT_THEME_ID]）：\n${missing.join("\n")}`,
  );
  assert.equal(Object.keys(TABLE).length, THEMES.length, "有表外多余的行");
});

test("深色主题的终端底色/前景与 App.css 的 editor 令牌逐字一致", () => {
  const drift: string[] = [];
  for (const t of THEMES) {
    if (t.light) continue;
    const want = editorTokens(t.id === "midnight" ? null : t.id);
    const got = TABLE[t.id];
    if (got.bg !== want.bg) drift.push(`${t.id} bg: 表 ${got.bg} ≠ css ${want.bg}`);
    if (got.fg !== want.fg) drift.push(`${t.id} fg: 表 ${got.fg} ≠ css ${want.fg}`);
  }
  assert.deepEqual(drift, [], `深色终端配色与 editor 令牌漂移：\n${drift.join("\n")}`);
});

test("深色主题的终端底色等于画布底色（终端与聊天层同底）", () => {
  const drift: string[] = [];
  for (const t of THEMES) {
    if (t.light) continue;
    const body =
      t.id === "midnight"
        ? /@theme\s*\{(.*?)\n\}/s.exec(css)?.[1]
        : new RegExp(`(?:^|\\n)\\[data-theme="${t.id}"\\]\\s*\\{([^]*?)\\n\\}`).exec(css)?.[1];
    const canvas = /--color-canvas:\s*(#[0-9a-fA-F]{6})/.exec(body ?? "")?.[1]?.toLowerCase();
    assert.ok(canvas, `${t.id} 缺 --color-canvas`);
    if (TABLE[t.id].bg !== canvas) drift.push(`${t.id}: 终端 ${TABLE[t.id].bg} ≠ 画布 ${canvas}`);
  }
  assert.deepEqual(drift, [], `深色终端底与画布不一致，切到聊天层会跳色：\n${drift.join("\n")}`);
});

test("浅色主题的终端底色是近白、前景够深（不追求与 editor-bg 相同）", () => {
  const bad: string[] = [];
  for (const t of THEMES) {
    if (!t.light) continue;
    const got = TABLE[t.id];
    const bgLum = lum(got.bg);
    const fgLum = lum(got.fg);
    // 底色近白：亮但不要求是 #ffffff（各主题保留自己的色相）
    if (bgLum < 245) bad.push(`${t.id} bg ${got.bg} 太暗（lum ${bgLum.toFixed(1)}）`);
    // 前景够深：保证正文可读，别出现浅底浅字
    if (fgLum > 120) bad.push(`${t.id} fg ${got.fg} 太浅（lum ${fgLum.toFixed(1)}）`);
    // 底色不得纯白——纯白整屏当终端刺眼，这正是浅色行与 editor-bg 分家的理由
    if (got.bg === "#ffffff") bad.push(`${t.id} bg 退回纯白 #ffffff`);
  }
  assert.deepEqual(bad, [], `浅色终端配色越界：\n${bad.join("\n")}`);
});
