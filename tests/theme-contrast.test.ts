import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { THEMES } from "../src/themes.ts";
import { DEFAULT_CUSTOM_THEME, deriveThemeTokens } from "../src/custom-theme.ts";

/**
 * 主题令牌的结构性约束（design-system.md「主题令牌」「线条语言」）。
 * 这些规则以前只写在文档里，v3.85 因浅色主题浮起梯度塌陷（strip/inset/raised
 * 亮度差只有 1–4，整页发平、卡片看不见）而补成可执行断言。
 */
const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");

/** 感知亮度近似值：只用于「谁比谁浅」的排序与阶梯步进，不用于对比度判定 */
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 相对亮度：必须先把 sRGB 线性化，直接拿 0–255 加权会严重高估暗色、低算对比度 */
function relLum(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取某个主题块里的令牌值；@theme 默认块用 themeId=null */
function tokens(themeId: string | null): Record<string, string> {
  const src =
    themeId === null
      ? /@theme \{(.*?)\n\}/s.exec(css)?.[1]
      : new RegExp(`\\[data-theme="${themeId}"\\] \\{(.*?)\\n\\}`, "s").exec(
          css,
        )?.[1];
  assert.ok(src, `找不到主题块 ${themeId ?? "@theme"}`);
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g))
    out[m[1]] = m[2];
  return out;
}

const LIGHT_THEMES = [
  "midnight-light", "terracotta-light", "ayu-light", "mocha-light",
  "neutral-light", "dracula-light", "shadcn-light",
];

test("七套浅色主题都存在", () => {
  for (const id of LIGHT_THEMES) assert.ok(Object.keys(tokens(id)).length > 0);
});

test("mocha-light 与 shadcn-light 底色不得相同", () => {
  const m = tokens("mocha-light");
  const s = tokens("shadcn-light");
  assert.notEqual(m.canvas, s.canvas, "两套浅色曾共用同一 canvas hex");
  assert.notEqual(m.rail, s.rail, "两套浅色曾共用同一 rail hex");
});

test("浅色浮起梯度每一档都可分辨（canvas→strip→inset→raised 亮度差 ≥4）", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    const ladder = ["canvas", "strip", "inset", "raised"];
    for (let i = 0; i < ladder.length - 1; i++) {
      const step = lum(t[ladder[i + 1]]) - lum(t[ladder[i]]);
      assert.ok(
        step >= 4,
        `${id}: ${ladder[i]}→${ladder[i + 1]} 只差 ${step.toFixed(1)}，梯度塌陷（页面会发平、卡片看不见）`,
      );
    }
  }
});

test("浅色浮起次序：rail < canvas < rail2 < strip < inset < raised", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    const order = ["rail", "canvas", "rail2", "strip", "inset", "raised"];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        lum(t[order[i]]) < lum(t[order[i + 1]]),
        `${id}: ${order[i]} 不比 ${order[i + 1]} 暗，浮起方向反了`,
      );
    }
  }
});

test("深色浮起次序：rail < canvas < rail2 < strip < inset < raised（七套同一顺序）", () => {
  // 2026-10-24：原先四套 rail2 比画布暗、三套比画布亮，项目页（rail2 底）在不同主题里一会儿沉一会儿浮
  for (const { id } of THEMES.filter((t) => !("light" in t))) {
    const t = { ...tokens(null), ...(id === "midnight" ? {} : tokens(id)) };
    const order = ["rail", "canvas", "rail2", "strip", "inset", "raised"];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(
        lum(t[order[i]]) < lum(t[order[i + 1]]),
        `${id}: ${order[i]} 不比 ${order[i + 1]} 暗`,
      );
    }
  }
});

test("浅色选中态与线条必须比所在底色深", () => {
  for (const id of LIGHT_THEMES) {
    const t = tokens(id);
    assert.ok(lum(t["rail-sel"]) < lum(t.rail), `${id}: 侧栏选中行不比侧栏深`);
    assert.ok(lum(t["seg-sel"]) < lum(t["rail-sel"]), `${id}: 分段选中不够深`);
    assert.ok(lum(t.hairline) < lum(t.canvas), `${id}: hairline 在 canvas 上看不见`);
    assert.ok(lum(t.field) < lum(t.hairline), `${id}: field 边不比 hairline 明显`);
    assert.ok(lum(t.bubble) < lum(t.canvas), `${id}: 消息气泡不比 canvas 深`);
  }
});

test("浅色状态语义色是浅底深字（pill 底比文字浅）", () => {
  const t = tokens("midnight-light"); // 语义色在 [data-theme$="-light"] 统一覆写，取任一浅色主题解析不到则回落
  const shared = /\[data-theme\$="-light"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const get = (k: string) =>
    new RegExp(`--color-${k}:\\s*(#[0-9a-fA-F]{6})`).exec(shared)?.[1] ??
    t[k];
  for (const [bg, fg] of [
    ["ok", "ok-text"],
    ["err", "err-text"],
    ["warn", "warn-text"],
    ["diff-add-bg", "diff-add-fg"],
    ["diff-del-bg", "diff-del-fg"],
  ]) {
    const b = get(bg);
    const f = get(fg);
    assert.ok(b && f, `缺令牌 ${bg}/${fg}`);
    assert.ok(
      lum(b) > lum(f),
      `浅色 ${bg}(${b}) 应比 ${fg}(${f}) 浅——深底浅字只在深色主题成立`,
    );
    // 文字要读得出来：WCAG AA 正文档 4.5:1
    const ratio = contrast(b, f);
    assert.ok(ratio >= 4.5, `浅色 ${bg}/${fg} 对比度仅 ${ratio.toFixed(2)}:1`);
  }
});

test("开关令牌深浅都成立：滑块必须比轨道浅", () => {
  const dark = tokens(null);
  assert.ok(
    lum(dark["switch-knob"]) > lum(dark["switch-off"]),
    "深色：滑块不比轨道浅",
  );
  const shared = /\[data-theme\$="-light"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const get = (k: string) =>
    new RegExp(`--color-${k}:\\s*(#[0-9a-fA-F]{6})`).exec(shared)![1];
  assert.ok(
    lum(get("switch-knob")) > lum(get("switch-off")),
    "浅色：滑块不比轨道浅",
  );
  // 轨道要能从页面底色里看出来（对比任一浅色主题的 canvas）
  for (const id of LIGHT_THEMES) {
    assert.ok(
      lum(tokens(id).canvas) - lum(get("switch-off")) >= 8,
      `${id}: 关闭态开关轨道与 canvas 太接近，开关会看不见`,
    );
  }
});

test("原生表单控件配色跟随主题，浅色下不被全局 dark 覆盖", () => {
  assert.match(
    css,
    /:root\s*\{[\s\S]*?color-scheme:\s*dark;/,
    "默认原生控件仍保持深色配色",
  );
  assert.match(
    css,
    /\[data-platform="windows"\]\[data-theme\$="-light"\]\s*\{\s*color-scheme:\s*light;/,
    "Windows 浅色主题必须覆盖为 light color-scheme",
  );
  assert.doesNotMatch(
    css,
    /:root:not\(\[data-theme\$="-light"\]\)/,
    "不要通过改变根节点选择器影响 macOS/Linux 的其它主题变量",
  );
});

test("PDF 页宿主从全局 dark color-scheme 隔离（WebView2 白屏）", () => {
  assert.match(
    css,
    /\[data-page-num\]\s*\{\s*color-scheme:\s*only light;/,
    "PDF 页必须锁定 light，不能继承 :root dark",
  );
  assert.match(
    css,
    /\[data-page-num\]\s*>\s*\.textLayer\s*\{\s*background-color:\s*transparent;/,
    "textLayer 不得铺 Canvas 白底盖住 canvas",
  );
});

/** 取平台覆写块里的令牌值：[data-platform="mac"][data-theme="id"] { ... } */
function platformTokens(
  platform: string,
  themeId: string,
): Record<string, string> {
  const src = new RegExp(
    `\\[data-platform="${platform}"\\]\\[data-theme="${themeId}"\\] \\{(.*?)\\n\\}`,
    "s",
  ).exec(css)?.[1];
  assert.ok(src, `找不到平台覆写块 ${platform}/${themeId}`);
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g))
    out[m[1]] = m[2];
  return out;
}

test("macOS 浅色中间档：l3 过 AA 正文线、l4 过 AA 大字线", () => {
  for (const id of LIGHT_THEMES) {
    const base = tokens(id);
    const mac = platformTokens("mac", id);
    const win = platformTokens("windows", id);
    // 中间档必须落在「原值 < mac < Windows 值」的压深方向上
    for (const k of ["l3", "l4"]) {
      assert.ok(
        lum(mac[k]) < lum(base[k]) && lum(mac[k]) > lum(win[k]),
        `${id}: mac ${k} 不在原值与 Windows 值之间`,
      );
    }
    // l3 ≥ 4.5:1（WCAG AA 正文）；l4 ≥ 3:1（AA 大字线，最浅辅助档的设计底线）
    const c3 = contrast(mac.l3, base.canvas);
    const c4 = contrast(mac.l4, base.canvas);
    assert.ok(c3 >= 4.5, `${id}: mac l3/canvas 对比度仅 ${c3.toFixed(2)}:1`);
    assert.ok(c4 >= 3.0, `${id}: mac l4/canvas 对比度仅 ${c4.toFixed(2)}:1`);
  }
});


function wellColor(palette: Record<string, string>, surface: "canvas" | "workspace"): string {
  const rule = /\.ccode-well \{([^}]+)\}/.exec(css)?.[1] ?? "";
  const mix = /color-mix\(in srgb, var\(--ccode-surface-base, var\(--color-canvas\)\) (\d+)%, var\(--color-raised\)\)/.exec(rule);
  assert.ok(mix, "全局内容卡必须从当前工作面派生，不固定用项目 rail2");
  const weight = Number(mix[1]) / 100;
  const base = palette[surface === "workspace" ? "rail2" : "canvas"];
  return "#" + [1, 3, 5].map((offset) => {
    const canvas = parseInt(base.slice(offset, offset + 2), 16);
    const raised = parseInt(palette.raised.slice(offset, offset + 2), 16);
    return Math.round(canvas * weight + raised * (1 - weight)).toString(16).padStart(2, "0");
  }).join("");
}

test("全局内容卡共用不透明混色，项目与普通页面声明各自画布", () => {
  assert.match(css, /@layer components \{[\s\S]*?\.ccode-well \{\s*background-color: color-mix\(in srgb, var\(--ccode-surface-base, var\(--color-canvas\)\) 65%, var\(--color-raised\)\);\s*\}/);
  assert.equal([...css.matchAll(/\.ccode-well\s*\{/g)].length, 1);
  assert.match(css, /\[data-surface="canvas"\] \{\s*--ccode-surface-base: var\(--color-canvas\);/);
  assert.match(css, /\[data-surface="workspace"\] \{\s*--ccode-surface-base: var\(--color-rail2\);/);
  const pageFrame = readFileSync(new URL("../src/components/PageFrame.tsx", import.meta.url), "utf8");
  assert.match(pageFrame, /data-surface=\{surface\}/);
  assert.match(pageFrame, /surface === "workspace" \? "bg-rail2" : "bg-canvas"/);
  assert.match(pageFrame, /projectWellClass = "ccode-well rounded-lg p-3"/);
  const floatRule = /\n\.ccode-float-surface \{([^}]+)\}/.exec(css)?.[1] ?? "";
  assert.match(floatRule, /--ccode-surface-base: var\(--color-canvas\)/);
  assert.match(floatRule, /background-color: var\(--color-raised\)/);
});

test("十四套主题、两种工作面的内容卡提亮一致，正文对比度不低于 4.5", () => {
  for (const { id } of THEMES) {
    const palette = { ...tokens(null), ...(id === "midnight" ? {} : tokens(id)) };
    for (const surface of ["canvas", "workspace"] as const) {
      const well = wellColor(palette, surface);
      const base = palette[surface === "workspace" ? "rail2" : "canvas"];
      assert.ok(lum(well) - lum(base) >= 4, `${id}/${surface}: 卡片与画布未拉开层次`);
      assert.ok(lum(well) < lum(palette.raised), `${id}/${surface}: 卡片不应比浮层更亮`);
      assert.notEqual(well, "#ffffff", `${id}/${surface}: 卡片不应漂成纯白`);
      assert.ok(contrast(palette.l2, well) >= 4.5, `${id}/${surface}: 正文在卡片上不可读`);
    }
  }
});

test("自定义画布变化时全局卡片同步派生，近白画布不擅自调暗", () => {
  const variants = [
    DEFAULT_CUSTOM_THEME,
    { rail: "#8b654c", canvas: "#eddcca", accent: "#c58642" },
    { rail: "#13221e", canvas: "#213c32", accent: "#83cdaa" },
    { rail: "#ead7f0", canvas: "#eee1f2", accent: "#9751a1" },
  ];
  for (const surface of ["canvas", "workspace"] as const) {
    const colors = variants.map((seeds) => {
      const palette = deriveThemeTokens(seeds).tokens;
      const well = wellColor(palette, surface);
      const base = palette[surface === "workspace" ? "rail2" : "canvas"];
      assert.ok(lum(well) > lum(base));
      assert.ok(lum(well) < lum(palette.raised));
      assert.ok(contrast(palette.l2, well) >= 4.5);
      return well;
    });
    assert.equal(new Set(colors).size, variants.length);
    const white = deriveThemeTokens({ rail: "#f0f0f0", canvas: "#fcfcfc", accent: "#0169cc" });
    assert.equal(white.tokens.canvas, "#fcfcfc");
    assert.ok(white.warnings.some((message) => message.includes("太浅")));
    assert.ok(contrast(white.tokens.l2, wellColor(white.tokens, surface)) >= 4.5);
  }
});

test("科研步骤与流程遮罩接入共享底色，工作树和目标继续复用同一内容井", () => {
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const cards = source("components/TaskCardsSection.tsx");
  assert.match(cards, /className="ccode-well mt-2 rounded-lg px-4 py-3\.5 shadow-sm"/);
  const flow = source("components/StepFlow.tsx");
  assert.match(flow, /ccode-well relative z-10 w-4 shrink-0/);
  assert.match(flow, /bare \? "" : "ccode-well rounded-md px-2\.5 py-2"/);
  const group = source("components/ProjectGroup.tsx");
  assert.match(group, /className="ccode-well shrink-0 px-\[3px\]"/);
  assert.match(group, /className="ccode-well mb-3 rounded-md px-3 py-2\.5"/);
  assert.match(source("pages/WorkspacesPage.tsx"), /ccode-well group rounded-lg p-3/);
  for (const file of ["CodingProjectView", "ProjectUserTasksView", "LitWatchCard", "ResourceListSection", "ScheduleSection"]) {
    assert.match(source(`components/${file}.tsx`), /projectWellClass/, file);
  }
  assert.match(source("components/ProjectAgentsView.tsx"), /row.isProjectDefault \? "bg-seg-sel" : "ccode-well"/);
});

/**
 * 滚动条拇指的对比度闸门。
 *
 * 拇指是「用户界面组件」——WCAG 2.1 SC 1.4.11 要求 3:1（非文本）。早先深色
 * `rgba(255,255,255,0.12)`、浅色 `rgba(0,0,0,0.16)` 实测最差只有 1.35:1 / 1.43:1，
 * 是全站唯一没被任何测试覆盖的硬性对比度失败。拇指是半透明的，必须先在每一套
 * 主题的每个表面色上合成出真实颜色，再算对比度——直接拿 alpha 比是错的。
 */
function over(alpha: number, white: boolean, bg: string): string {
  const h = bg.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const target = white ? 255 : 0;
  return (
    "#" +
    ch
      .map((c) => Math.round(alpha * target + (1 - alpha) * c))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** 拇指铺在哪些表面上：滚动条可能出现在任意一层，取全部表面令牌取最差 */
const SCROLLBAR_SURFACES = [
  "canvas", "strip", "inset", "raised", "rail", "rail2",
];

function alphaFrom(rule: RegExp): number {
  const m = rule.exec(css);
  assert.ok(m, "找不到滚动条拇指规则");
  const a = Number(m[1]);
  assert.ok(Number.isFinite(a) && a > 0 && a <= 1, `非法 alpha：${m[1]}`);
  return a;
}

test("滚动条拇指在全部十四套主题上都过 3:1（WCAG 非文本）", () => {
  const darkAlpha = alphaFrom(
    /::-webkit-scrollbar-thumb\s*\{\s*background:\s*rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/,
  );
  const lightAlpha = alphaFrom(
    /\[data-theme\$="-light"\]\s*::-webkit-scrollbar-thumb\s*\{\s*background:\s*rgba\(0,\s*0,\s*0,\s*([\d.]+)\)/,
  );
  assert.ok(lightAlpha > 0 && darkAlpha > 0);

  // 主题清单从 THEMES 取，不手抄——手抄过一次就漏了 terracotta、混进了不存在的 charcoal。
  // 沉浸黑（midnight）没有独立的 `[data-theme]` 块，它继承 `@theme` 默认值，故用 null。
  const themeIds: (string | null)[] = [
    null,
    ...THEMES.map((t) => t.id).filter((id) => id !== "midnight"),
  ];
  assert.equal(
    themeIds.length,
    THEMES.length,
    "@theme 只喂 midnight 一套，其余主题必须都有自己的块",
  );
  const failures: string[] = [];
  for (const id of themeIds) {
    const palette = tokens(id);
    const light = (id ?? "").endsWith("-light");
    const alpha = light ? lightAlpha : darkAlpha;
    for (const surface of SCROLLBAR_SURFACES) {
      const bg = palette[surface];
      if (!bg) continue;
      const ratio = contrast(over(alpha, !light, bg), bg);
      if (ratio < 3) {
        failures.push(
          `${id ?? "@theme"}/${surface}: ${ratio.toFixed(2)}:1`,
        );
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `滚动条拇指低于 3:1：\n${failures.join("\n")}`,
  );
});

test("focus ring（l3）对画布对比度全主题 ≥3:1（WCAG 2.2 Focus Appearance）", () => {
  // focus 环是 outline: 1px solid var(--color-l3)（App.css 全局基线），可见性由
  // l3 与所在底色（canvas）的对比承载。逐主题锁定，防未来调 l3 档时悄悄跌破。
  const themeIds: (string | null)[] = [
    null,
    ...THEMES.map((t) => t.id).filter((id) => id !== "midnight"),
  ];
  const failures: string[] = [];
  for (const id of themeIds) {
    const t = tokens(id);
    const ratio = contrast(t["l3"], t.canvas);
    if (ratio < 3) {
      failures.push(`${id ?? "@theme"}: ${ratio.toFixed(2)}:1`);
    }
  }
  // 自定义主题：两个种子方向（深/浅）都派生一遍检查
  for (const seeds of [DEFAULT_CUSTOM_THEME, { ...DEFAULT_CUSTOM_THEME, canvas: "#f4f2ee", accent: "#b3554f" }]) {
    const derived = deriveThemeTokens(seeds).tokens;
    const ratio = contrast(derived.l3, derived.canvas);
    if (ratio < 3) {
      failures.push(`custom(${seeds.canvas}): ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `focus ring 低于 3:1：\n${failures.join("\n")}`);
});

/** color-mix(in oklab, A p%, B)：oklab 域线性插值（与 CSS 同构；混黑保色相，
 *  这正是两段式第一段的用意——srgb 直混近中性画布会把浅 cta 洗成灰彩） */
function srgb2lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lin2srgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function hex2rgb(hex: string): number[] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function rgb2hex(ch: number[]): string {
  const cl = (x: number) =>
    Math.round(Math.min(255, Math.max(0, x)))
      .toString(16)
      .padStart(2, "0");
  return `#${cl(ch[0])}${cl(ch[1])}${cl(ch[2])}`;
}
function rgb2lab(ch: number[]): number[] {
  // srgb2lin 期望 0–1，hex2rgb 给的是 0–255——这里必须先除（oklch 版的除法在 hex2oklab 里）
  const [R, G, B] = ch.map((v) => srgb2lin(v / 255));
  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
function lab2rgb(lab: number[]): number[] {
  const [L, a, b] = lab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => lin2srgb(x) * 255);
}
function mixOklab(h1: string, h2: string, p: number): string {
  const A = rgb2lab(hex2rgb(h1));
  const B = rgb2lab(hex2rgb(h2));
  return rgb2hex(lab2rgb(A.map((v, i) => (v * p) / 100 + (B[i] * (100 - p)) / 100)));
}
/** srgb 伽马域逐通道插值（color-mix in srgb 同域） */
function mixSrgbHex(h1: string, h2: string, p: number): string {
  const A = hex2rgb(h1);
  const B = hex2rgb(h2);
  return rgb2hex(A.map((v, i) => (v * p) / 100 + (B[i] * (100 - p)) / 100));
}
function pct(re: RegExp, src: string, name: string): number {
  const m = re.exec(src);
  assert.ok(m, `热力图公式缺 ${name}`);
  return Number(m[1]);
}

test("热力图五档色阶（cta 单极梯子）全主题可辨：方向单调 / 步进 / 彩度单调 / 色相恒定 / 顶档 ≥3:1", () => {
  // 公式从 App.css 解析（单一出处）：改百分比即改测试。
  // 2026-10-16 重做口径：全部只向无彩极点（黑/白）做 oklab 混合——色相恒定、
  // 彩度按比例单调按构造成立，断言钉住防回潮（向画布/srgb 混会拉色相、塌彩度）。
  // 深色 = cta→黑 54/69/84 + 纯 cta 顶档；neutral
  // 深蓝 cta 锚点先向白抬（各主题块覆写）；浅色 = 白/黑双极倒转（越深越浓），
  // 顶档 58%黑保任意 cta（含黄色）对近白卡底 ≥3:1。
  const themeSrc = /@theme \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const darkP = [1, 2, 3].map((n) =>
    pct(new RegExp(`--heat-${n}: color-mix\\(in oklab, var\\(--color-cta\\) (\\d+)%, black\\)`), themeSrc, `--heat-${n}`));
  assert.match(themeSrc, /--heat-4:\s*var\(--color-cta\)/, "深色顶档 = 纯 cta");
  const l0P = pct(
    /--heat-0: color-mix\(in oklab, var\(--color-inset\) (\d+)%, var\(--color-canvas\)\)/,
    themeSrc,
    "--heat-0",
  );

  const lightSrc = /\[data-theme\$="-light"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const lightWhite = [1, 2].map((n) =>
    pct(new RegExp(`--heat-${n}: color-mix\\(in oklab, var\\(--color-cta\\) (\\d+)%, white\\)`), lightSrc, `浅色 --heat-${n}`));
  const lightBlack = [3, 4].map((n) =>
    pct(new RegExp(`--heat-${n}: color-mix\\(in oklab, var\\(--color-cta\\) (\\d+)%, black\\)`), lightSrc, `浅色 --heat-${n}`));

  const neutSrc = /\[data-theme="neutral"\] \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  const anchorP = pct(/--heat-anchor: color-mix\(in oklab, var\(--color-cta\) (\d+)%, white\)/, neutSrc, "--heat-anchor");
  const neutP = [1, 2, 3].map((n) =>
    pct(new RegExp(`--heat-${n}: color-mix\\(in oklab, var\\(--heat-anchor\\) (\\d+)%, black\\)`), neutSrc, `neutral --heat-${n}`));
  assert.match(neutSrc, /--heat-4:\s*var\(--heat-anchor\)/, "neutral 顶档 = 白抬锚点");

  const chromaOf = (hex: string) => {
    const [, a, b] = rgb2lab(hex2rgb(hex));
    return Math.hypot(a, b);
  };
  const hueOf = (hex: string) => {
    const [, a, b] = rgb2lab(hex2rgb(hex));
    return (Math.atan2(b, a) * 180) / Math.PI;
  };
  const lightnessOf = (hex: string) => rgb2lab(hex2rgb(hex))[0];

  const failures: string[] = [];
  function check(name: string, id: string | null, t: Record<string, string>, isLight: boolean) {
    const bg = wellColor(t, "canvas");
    const ladder =
      id === "neutral"
          ? (() => {
              const anchor = mixOklab(t.cta, "#ffffff", anchorP);
              return [...neutP.map((p) => mixOklab(anchor, "#000000", p)), anchor];
            })()
          : isLight
            ? [
                mixOklab(t.cta, "#ffffff", lightWhite[0]),
                mixOklab(t.cta, "#ffffff", lightWhite[1]),
                mixOklab(t.cta, "#000000", lightBlack[0]),
                mixOklab(t.cta, "#000000", lightBlack[1]),
              ]
            : [...darkP.map((p) => mixOklab(t.cta, "#000000", p)), t.cta];
    const L = ladder.map(lightnessOf);
    const C = ladder.map(chromaOf);
    const H = ladder.map(hueOf);
    // 方向：深色 L 递增、浅色 L 递减（越深越浓）；相邻步进 ≥0.04（oklab L 单位）
    const dir = isLight ? -1 : 1;
    for (let i = 0; i < 3; i++) {
      if (dir * (L[i + 1] - L[i]) < 0.04)
        failures.push(`${name}: 档${i + 1}→${i + 2} 步进 ${(L[i + 1] - L[i]).toFixed(3)} 过小`);
    }
    // 彩度：深色全程不降；浅色前三档不降、深阶顶档 ≥0.55×l3（压深天然低彩）
    if (isLight) {
      if (C[1] < C[0] || C[2] < C[1]) failures.push(`${name}: 浅色前三档彩度不单调升`);
      if (C[3] < 0.55 * C[2]) failures.push(`${name}: 顶档彩度 ${(C[3] / C[2]).toFixed(2)}×l3 塌方`);
    } else {
      for (let i = 0; i < 3; i++)
        if (C[i + 1] < C[i] - 1e-9) failures.push(`${name}: 档${i + 1}→${i + 2} 彩度下降`);
    }
    // 色相恒定：无彩极点混合按构造成立；>3° 说明混进了带色相的东西（画布/srgb 回潮）
    const spread = Math.max(...H) - Math.min(...H);
    if (spread > 3) failures.push(`${name}: 梯内色相漂 ${spread.toFixed(1)}°`);
    // 底档不贴死空槽：深色空槽是 --heat-0（inset×canvas 若隐若现），浅色仍是 inset
    const l0 = isLight ? t.inset : mixOklab(t.inset, t.canvas, l0P);
    const floor = Math.abs(L[0] - lightnessOf(l0)) + C[0] / 2;
    if (floor < 0.05) failures.push(`${name}: 底档距空槽 ${floor.toFixed(3)} 贴死`);
    // 顶档对卡底非文本 3:1（WCAG 1.4.11）
    const topC = contrast(ladder[3], bg);
    if (topC < 3) failures.push(`${name}: 顶档对卡底 ${topC.toFixed(2)}:1 < 3`);
  }

  const themeIds: (string | null)[] = [
    null,
    ...THEMES.map((t) => t.id).filter((id) => id !== "midnight"),
  ];
  for (const id of themeIds) {
    check(id ?? "midnight(@theme)", id, tokens(id), (id ?? "").endsWith("-light"));
  }
  for (const seeds of [
    DEFAULT_CUSTOM_THEME,
    { rail: "#f0f0f0", canvas: "#fcfcfc", accent: "#0169cc" },
    { rail: "#e7e4da", canvas: "#efede6", accent: "#ffcc00" }, // 黄强调 × 浅画布：浅色梯子的压力位
    { rail: "#0b0e14", canvas: "#10141c", accent: "#ffcc00" }, // 黄强调 × 暗画布
  ]) {
    const derived = deriveThemeTokens(seeds).tokens;
    check(`custom ${seeds.accent}`, null, derived, lum(derived.canvas) > 200);
  }
  assert.deepEqual(failures, [], `热力图色阶断档：\n${failures.join("\n")}`);
});

test("聊天回答的字适合长读：Mac 细字下正文 l1 对画布 11.5–16:1、加粗同色；Windows 不认细字，正文 l2 8.5–11.5:1、加粗更亮且不超过 14:1", () => {
  // 2026-10-25 用户选 C：聊天区灰度抗锯齿（笔画细一档）+ 正文提到 l1；Windows 没有细字，留原口径
  const root = /@theme \{(.*?)\n\}/s.exec(css)?.[1] ?? "";
  assert.match(root, /--color-chat-text:\s*var\(--color-l1\)/);
  assert.match(root, /--color-chat-strong:\s*var\(--color-l1\)/);
  assert.match(css, /\.ccode-chat-body,\s*\.ccode-chat-user,\s*\.md-chat,\s*\.ccode-chat-composer,\s*\.ccode-chat-scroll \{\s*-webkit-font-smoothing:\s*antialiased/);
  const win = /\[data-platform="windows"\] \{\s*--color-chat-text:\s*var\(--color-l2\);\s*--color-chat-strong:\s*color-mix\(in oklab, var\(--color-l1\) 60%, var\(--color-l2\)\);/;
  assert.match(css, win, "Windows 留 l2 正文 + 六成 l1 加粗");
  const bad: string[] = [];
  for (const t of THEMES) {
    const v = { ...tokens(null), ...(t.id === "midnight" ? {} : tokens(t.id)) };
    const mac = contrast(v.l1, v.canvas);
    if (mac < 11.5 || mac > 16) bad.push(`${t.id} Mac 正文 l1 对画布 ${mac.toFixed(2)}:1`);
    const ct = contrast(v.l2, v.canvas);
    const cs = contrast(mixOklab(v.l1, v.l2, 60), v.canvas);
    if (ct < 8.5 || ct > 11.5) bad.push(`${t.id} Windows 正文 l2 对画布 ${ct.toFixed(2)}:1`);
    if (cs <= ct) bad.push(`${t.id} Windows 加粗不比正文亮（${cs.toFixed(2)} ≤ ${ct.toFixed(2)}）`);
    if (cs > 14) bad.push(`${t.id} Windows 加粗对画布 ${cs.toFixed(2)}:1，长读刺眼`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});
