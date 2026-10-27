import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compile } from "@tailwindcss/node";
import { build } from "esbuild";
import postcss from "postcss";
import ts from "typescript";

const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

function classes(file: string): Array<{ tag: string; text: string; literal: boolean }> {
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values: Array<{ tag: string; text: string; literal: boolean }> = [];
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === "className" && node.initializer) {
      const element = node.parent.parent;
      if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) {
        const literal = ts.isStringLiteral(node.initializer);
        values.push({
          tag: element.tagName.getText(ast), literal,
          text: literal ? node.initializer.text : node.initializer.getText(ast),
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return values;
}

test("全局卡片迁移覆盖工作台/技能/MCP/连接/设置等管理页", () => {
  const minimumCards: Record<string, number> = {
    // WorkbenchPage 4→3（2026-09-13）：空态的虚线壳卡改为管理页同款裸 EmptyState
    // （「空状态允许保留连续画布」），内容卡只剩 hero / 正在进行行 / 待验收行三处。
    // 3→1（2026-10-27）：hero 大卡删掉、待验收并进「等你拍板」细线列表，只剩正在进行行。
    // 同日第二批：正在进行改成项目卡，卡片在 components/WorkbenchProjectCard.tsx（下面单独钉）。
    WorkbenchPage: 0, SkillsPage: 4, McpPage: 6, ProfilesPage: 5,
    SettingsPage: 6, StatsPage: 2, SessionsPage: 1,
  };
  for (const [page, minimum] of Object.entries(minimumCards)) {
    const cards = classes(`pages/${page}.tsx`).filter((item) => item.text.includes("ccode-well"));
    assert.ok(cards.length >= minimum, `${page}: 已迁移内容卡不应退回单独配色`);
    for (const card of cards.filter((item) => item.literal)) {
      assert.doesNotMatch(card.text, /(?:^|\s)bg-(?:strip|inset|raised|canvas)(?:\/\d+)?(?:\s|$)/, `${page}: 双底色覆盖`);
    }
  }
  assert.doesNotMatch(source("pages/WorkbenchPage.tsx"), /bg-raised\/(?:40|55)/);
  assert.match(source("components/WorkbenchProjectCard.tsx"), /ccode-well/);
  assert.match(source("pages/ProfilesPage.tsx"), /installed\s*\? "border-field ccode-well"\s*: "border-hairline"/);
  assert.match(source("components/ProjectAgentsView.tsx"), /row.isProjectDefault \? "bg-seg-sel" : "ccode-well"/);
});

test("科研子卡/设置卡/知识条目统一，独立画布不继承项目底色", () => {
  for (const name of [
    "ResearchAcceptancePanel", "ResearchReproductionPanel", "ResearchEvidencePanel",
    "ResearchDecisionFields", "ResearchToolFields", "ResearchToolPreflight", "UpstreamResearchAcceptance",
    "ProjectSettingsDrawer", "ProjectMemoryPanel", "LitWatchCard", "ScheduleSection",
    "TemplatePicker", "TemplatePickModal", "SessionImportModal", "ArtifactChecklist",
  ]) {
    const cards = classes(`components/${name}.tsx`);
    assert.ok(cards.some((item) => item.text.includes("ccode-well")), name);
    for (const item of cards) {
      if (item.literal && ["section", "article", "fieldset", "details"].includes(item.tag)) {
        assert.doesNotMatch(item.text, /(?:^|\s)bg-(?:strip|inset|raised)(?:\s|$)/, name);
      }
    }
  }
  for (const name of ["ProjectSettingsDrawer", "PipelineEditor", "HistoryOverlay", "WorkspaceReviewView", "GatewayLibrary"]) {
    assert.match(source(`components/${name}.tsx`), /data-surface="canvas"/, `${name}: 独立画布需重置卡片基色`);
  }
});

test("编译后的卡片规则低于 hover/选中工具类，不改浮层外壳与语义色", async () => {
  const compiled = await compile(source("App.css"), {
    base: fileURLToPath(new URL("../src/", import.meta.url)),
    onDependency() {},
  });
  const css = postcss.parse(compiled.build(["bg-canvas", "bg-rail2", "bg-seg-sel", "bg-cta", "hover:bg-hover"]));
  function rule(selector: string) {
    const matches: postcss.Rule[] = [];
    css.walkRules((node) => { if (node.selector === selector) matches.push(node); });
    assert.ok(matches.length, `缺少 ${selector}`);
    return matches[0];
  }
  function layer(node: postcss.Node): string | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === "atrule" && parent.name === "layer") return parent.params;
    }
    return undefined;
  }
  // App.css 里有 @property 时 Tailwind 会在最前面另声明一层 properties（旧浏览器的初值兜底），不影响这四层的先后
  const order = css.nodes.find(
    (node) => node.type === "atrule" && node.name === "layer" && !node.nodes && node.params !== "properties",
  );
  assert.equal(order?.type === "atrule" ? order.params : undefined, "theme, base, components, utilities");
  assert.equal(layer(rule(".ccode-well")), "components");
  assert.match(rule(".ccode-well").toString(), /var\(--ccode-surface-base, var\(--color-canvas\)\) 65%/);
  for (const selector of [".hover\\:bg-hover:hover", ".bg-seg-sel", ".bg-cta"]) {
    assert.equal(layer(rule(selector)), "utilities");
  }
  assert.match(rule(".ccode-float-surface").toString(), /background-color: var\(--color-raised\)/);
  assert.match(rule(".ccode-float-surface").toString(), /--ccode-surface-base: var\(--color-canvas\)/);
  assert.match(rule('[data-surface="workspace"]').toString(), /var\(--color-rail2\)/);
  assert.match(rule('[data-surface="canvas"]').toString(), /var\(--color-canvas\)/);
});

test("共享页面框架真实渲染：项目与普通画布标记及控件保持独立", async () => {
  const bundle = await build({
    stdin: {
      contents: `export {createElement} from 'react';
        export {renderToStaticMarkup} from 'react-dom/server';
        export {PageFrame, NoticeBar, primaryActionClass, fieldClass, projectWellClass} from './src/components/PageFrame';`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "tsx",
    },
    bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
    external: ["react", "react-dom", "react-dom/server", "react/jsx-runtime"],
  });
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url), compiled, compiled.exports,
  );
  const { createElement: h, renderToStaticMarkup: render, PageFrame, NoticeBar, primaryActionClass, fieldClass, projectWellClass } = compiled.exports;
  for (const surface of ["canvas", "workspace"]) {
    const html = render(h(PageFrame, { surface },
      h("section", { className: projectWellClass }, h(NoticeBar, {}, "提示"))));
    assert.match(html, new RegExp(`data-surface="${surface}"`));
    assert.match(html, surface === "workspace" ? /bg-rail2/ : /bg-canvas/);
    assert.equal((html.match(/ccode-well/g) ?? []).length, 2);
  }
  assert.match(primaryActionClass, /bg-cta/);
  assert.match(fieldClass, /bg-canvas/);
  assert.doesNotMatch(primaryActionClass + fieldClass, /ccode-well/);
});
