import assert from "node:assert/strict";
import test from "node:test";
import { disableWorkerLanguageFeatures } from "../src/monaco-services.ts";

test("JSON / CSS / HTML / TS 的语言服务功能全关（只配了基础 worker），只留 JSON 自己的着色", () => {
  const calls: Record<string, Record<string, boolean>> = {};
  const defaults = (name: string) => ({ setModeConfiguration: (c: Record<string, boolean>) => (calls[name] = c) });
  const fake = {
    css: { cssDefaults: defaults("css"), scssDefaults: defaults("scss"), lessDefaults: defaults("less") },
    html: { htmlDefaults: defaults("html"), handlebarDefaults: defaults("handlebars"), razorDefaults: defaults("razor") },
    json: { jsonDefaults: defaults("json") },
    typescript: { typescriptDefaults: defaults("ts"), javascriptDefaults: defaults("js") },
  };
  disableWorkerLanguageFeatures(fake as never);
  assert.deepEqual(Object.keys(calls).sort(), ["css", "handlebars", "html", "js", "json", "less", "razor", "scss", "ts"]);
  for (const [name, config] of Object.entries(calls)) {
    for (const [feature, on] of Object.entries(config)) {
      assert.equal(on, name === "json" && feature === "tokens", `${name}.${feature}`);
    }
    // 点验里报过错的那几项必须在关掉的名单里
    for (const f of ["foldingRanges", "documentSymbols", "diagnostics", "colors", "links", "inlayHints", "codeActions"]) {
      assert.equal(config[f], false, `${name}.${f}`);
    }
  }
});
