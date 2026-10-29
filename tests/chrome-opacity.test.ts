import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHROME_OPACITIES,
  DEFAULT_CHROME_OPACITY,
  chromeOpacityLabel,
  chromeOpacityScale,
  chromeOpacityShortLabel,
  normalizeChromeOpacity,
} from "../src/chrome-opacity.ts";

const rust = readFileSync(
  new URL("../src-tauri/src/settings.rs", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/* Rust 的 KNOWN_CHROME_OPACITIES 是入库存真值的白名单：不在表里的值会被静默落回默认。
   前端加一档而 Rust 没跟上，现象是「选了没反应」——用户不会想到是白名单，只会当成
   设置坏了。这条断言把两侧钉在一起，任何一边漏加都在这里红。
   与 KNOWN_NAV_CAPSULE_DELAYS_MS 同款约定（那边的注释也记着同一个坑）。 */
test("挡位表与 Rust 白名单逐项一致", () => {
  const m = /const KNOWN_CHROME_OPACITIES: \[u32; \d+\] = \[([^\]]*)\];/.exec(rust);
  assert.ok(m, "settings.rs 里没找到 KNOWN_CHROME_OPACITIES，字段可能被改名了");
  const rustSteps = m[1].split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  assert.deepEqual(rustSteps, [...CHROME_OPACITIES]);

  const d = /pub const DEFAULT_CHROME_OPACITY: u32 = (\d+);/.exec(rust);
  assert.ok(d, "settings.rs 里没找到 DEFAULT_CHROME_OPACITY");
  assert.equal(Number(d[1]), DEFAULT_CHROME_OPACITY);
});

/* 默认档必须还原改版前：100 = 各主题原样。这条不是数字洁癖——设置项一旦默认值
   不等于旧观感，用户升级后什么都不动就看到界面变了，会当成升级事故。 */
test("缺省档是 100，倍率为 1", () => {
  assert.equal(DEFAULT_CHROME_OPACITY, 100);
  assert.equal(chromeOpacityScale(undefined), 1);
  assert.equal(chromeOpacityScale(100), 1);
  assert.ok(CHROME_OPACITIES.includes(100));
});

test("白名单外的值落回默认而不是算出野值", () => {
  for (const bad of [999, -1, 43, 101, "60", null, {}, Number.NaN]) {
    assert.equal(normalizeChromeOpacity(bad), DEFAULT_CHROME_OPACITY, `${String(bad)}`);
    assert.equal(chromeOpacityScale(bad), 1);
  }
  // 0 是合法档（完全不铺罩色），不能因为它是 falsy 就被当成「没设置」——
  // 与 nav capsule 的 0 = 立即是同一个坑。
  assert.equal(normalizeChromeOpacity(0), 0);
  assert.equal(chromeOpacityScale(0), 0);
});

test("倍率是百分数除以 100", () => {
  for (const pct of CHROME_OPACITIES) {
    assert.equal(chromeOpacityScale(pct), pct / 100, `${pct}`);
  }
});

test("两端单独措辞：它们不是某一档，是两种观感", () => {
  assert.match(chromeOpacityLabel(100), /原样/);
  assert.match(chromeOpacityLabel(0), /全透/);
  assert.equal(chromeOpacityLabel(50), "50%");
});

/* 基数是 CSS 变量、由壳上的系数相乘，JS 不持有 42/78/28 这些数。
   这条守住那个分工：规则本体一旦写死数字，改主题基数就要在 App.css 和 TS 两处对账。 */
test("App.css 收紧到基数 × 系数，规则本体不再写死百分比", () => {
  // 侧栏、顶栏、四周缝同一块玻璃：深色 2026-10-23 起、浅色 10-30 起罩色只在壳上一层，侧栏基数 0、不再分展开 / 图标态。
  // 10-30 用户嫌玻璃看不出来：深色 48% → 28%，浅色壳 + 侧栏各 78%（侧栏合成约 95%）→ 壳一层 60%
  assert.match(css, /--ccode-rail-base:\s*0%/);
  assert.match(css, /--ccode-shell-base:\s*28%/);
  assert.match(css, /data-chrome="light"\]\s*\{[^}]*--ccode-rail-base:\s*0%[^}]*--ccode-shell-base:\s*60%/);
  assert.ok(!/data-nav="icons"\]\s*\{[^}]*--ccode-rail-base/.test(css), "图标态不再另设基数");

  const rail = /\.ccode-app-rail\s*\{[^}]*\}/.exec(css);
  assert.ok(rail, "找不到 .ccode-app-rail 规则");
  assert.match(rail[0], /calc\(var\(--ccode-rail-base\) \* var\(--ccode-chrome-scale\)\)/);
  assert.ok(
    !/color-mix\(in srgb, var\(--color-rail\) \d+%/.test(rail[0]),
    "侧栏罩色里又出现了写死的百分比——基数应只声明在 .ccode-app-shell 里",
  );

  // 每条 color-mix 前要留一条不含 calc 的同基数声明：万一 WebKit 不接受
  // color-mix() 里的 calc()，作废的只是后一条，罩色退回基数而不是整条失效。
  assert.match(rail[0], /var\(--ccode-rail-base\), transparent\)/);
});

/* 选中行胶囊跟罩色同乘一个系数：罩色淡而胶囊不淡，胶囊就不再读作「这行被高亮」，
   而读作「壁纸上贴了一块不透明的东西」——用户把侧栏调透，最显眼的那块却没动。
   深色（2026-10-26）只叠 9% 前景色、玻璃透上来；不得退回实心 rail-sel 88%（那会把玻璃盖成一块黑）。
   浅色仍是 rail-sel，88% 只作为基数出现（声明在 .ccode-app-shell）。 */
test("深色选中行叠 9% 前景色并乘系数，不铺 rail-sel", () => {
  const sel = /\n\.ccode-app-rail \.bg-rail-sel\s*\{[^}]*\}/.exec(css);
  assert.ok(sel, "找不到 .ccode-app-rail .bg-rail-sel 规则");
  assert.match(sel[0], /var\(--color-l1\) calc\(9% \* var\(--ccode-chrome-scale\)\)/);
  assert.ok(!/--color-rail-sel/.test(sel[0]), "深色选中行又铺回了 rail-sel——会把玻璃盖成一块黑");
});

test("浅色选中行仍是 rail-sel 同乘系数，88% 只作为基数出现", () => {
  assert.match(css, /--ccode-lsel-base:\s*88%/);

  const sel = /:where\(\.ccode-app-shell\[data-chrome="light"\]\) \.ccode-app-rail \.bg-rail-sel\s*\{[^}]*\}/.exec(css);
  assert.ok(sel, "找不到浅色 .bg-rail-sel 规则");
  assert.match(sel[0], /calc\(var\(--ccode-lsel-base\) \* var\(--ccode-chrome-scale\)\)/);
  assert.ok(
    !/color-mix\(in srgb, var\(--color-rail-sel\) \d+%/.test(sel[0]),
    "选中行胶囊里又出现了写死的百分比——它必须留在缩放体系里",
  );
  assert.match(sel[0], /var\(--ccode-lsel-base\), transparent\)/);
  // 浅色规则必须排在深色之后才盖得住（两条权重相同）
  assert.ok(css.indexOf(sel[0]) > css.search(/\n\.ccode-app-rail \.bg-rail-sel\s*\{/), "浅色选中行规则要排在深色之后");
});

/* 顶栏自己不铺：深浅两套都靠壳那层罩（深色 28%、浅色 60%）。
   这一条钉住「顶栏那条规则没有藏着 percentage」，否则会与壳叠成两层。 */
test("顶栏不自己铺罩色：颜色由壳那层代表", () => {
  const titlebar = /\.ccode-titlebar\s*\{[^}]*\}/.exec(css);
  assert.ok(titlebar, "找不到 .ccode-titlebar 规则");
  assert.match(titlebar[0], /background:\s*transparent/);
  assert.ok(!titlebar[0].includes("color-mix"), "顶栏不该有 color-mix：会和壳那层叠起来");
});

/* 玻璃上的字（2026-10-30）：主题 l3 / l4 按实心画布配，压在磨砂上 l4 只剩 2.4–3.3:1。
   侧栏里两档上提；原值必须先在壳上存一份再混——自己引用自己是循环、整条作废，侧栏会退回未提亮的灰字。 */
test("侧栏玻璃上的 l3 / l4 上提一档，且不自引用", () => {
  assert.match(css, /\.ccode-app-shell\s*\{\s*--ccode-ink-l3:\s*var\(--color-l3\);\s*--ccode-ink-l4:\s*var\(--color-l4\);/);
  const ink = /\.ccode-app-rail\s*\{\s*--color-l3:[^}]*\}/.exec(css);
  assert.ok(ink, "找不到侧栏字档规则");
  assert.match(ink[0], /--color-l3:\s*color-mix\(in srgb, var\(--color-l2\) 60%, var\(--ccode-ink-l3\)\)/);
  assert.match(ink[0], /--color-l4:\s*color-mix\(in srgb, var\(--ccode-ink-l3\) 70%, var\(--ccode-ink-l4\)\)/);
  assert.ok(!/var\(--color-l[34]\)/.test(ink[0]), "侧栏字档自己引用了 --color-l3 / l4：循环引用整条作废");
});

test("分段短标签：两端用词、中间只写数", () => {
  assert.deepEqual(
    CHROME_OPACITIES.map((pct) => chromeOpacityShortLabel(pct)),
    ["全透", "25", "50", "75", "85", "原样"],
  );
});

/* macOS 全屏壳铺实心（2026-10-23）：全屏空间里材质透上来的是整面桌面壁纸。
   不乘系数是有意的——「全透」档在全屏下也不透，设置页 hint 写明。 */
test("Mac 全屏时壳铺实心 rail，不吃用户系数", () => {
  const fs = /\.ccode-app-shell\[data-fullscreen="true"\]\s*\{[^}]*\}/.exec(css);
  assert.ok(fs, "找不到 .ccode-app-shell[data-fullscreen=\"true\"] 规则");
  assert.match(fs[0], /background:\s*var\(--color-rail\)/);
  assert.ok(!fs[0].includes("--ccode-chrome-scale"), "全屏实心底不该乘透明度系数");

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /data-fullscreen=\{macFullscreen \? "true" : undefined\}/);
});

/* macOS 材质用菜单材质（Menu）：UnderWindowBackground 只模糊不压色，彩色壁纸色相直接透上来。
   建窗配置与 setup 里补挂的那一份必须一致，否则首帧和补挂后材质不同（窗口一闪）。 */
test("macOS 窗口材质：各份 tauri 配置与 lib.rs 都是 Menu", () => {
  for (const name of [
    "tauri.conf.json",
    "tauri.dev.conf.json",
    "tauri.dev.17576.conf.json",
    "tauri.dev.17577.conf.json",
  ]) {
    const conf = JSON.parse(
      readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"),
    );
    assert.deepEqual(conf.app.windows[0].windowEffects.effects, ["menu", "mica"], name);
  }
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /WindowEffect::Menu,\s*tauri::utils::WindowEffect::Mica/);
  assert.ok(!lib.includes("WindowEffect::UnderWindowBackground"));
});
