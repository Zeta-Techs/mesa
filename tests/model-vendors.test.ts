import test from "node:test";
import assert from "node:assert/strict";
import { vendorOf, groupModelsByVendor, visibleVendorGroups } from "../src/model-vendors.ts";

test("vendorOf：斜杠风格取前段", () => {
  assert.equal(vendorOf("openai/gpt-5"), "openai");
  assert.equal(vendorOf("Qwen/Qwen3-32B"), "qwen");
});

test("vendorOf：常见前缀并到同一家，版本号不另成组", () => {
  assert.equal(vendorOf("gpt-5.6-sol"), "openai");
  assert.equal(vendorOf("o3-pro"), "openai");
  assert.equal(vendorOf("o4-mini"), "openai");
  assert.equal(vendorOf("text-embedding-3-large"), "openai");
  assert.equal(vendorOf("gemini-3.5-flash"), "gemini");
  assert.equal(vendorOf("claude-sonnet-4"), "claude");
  assert.equal(vendorOf("Qwen3-32B"), "qwen");
  assert.equal(vendorOf("qwen-plus"), "qwen");
  assert.equal(vendorOf("wan2.5-t2i"), "qwen");
  assert.equal(vendorOf("wanx2.1"), "qwen");
  assert.equal(vendorOf("moonshot-v1-128k"), "kimi");
  assert.equal(vendorOf("kimi-k3"), "kimi");
});

test("vendorOf：表外取字母段，去掉版本数字", () => {
  assert.equal(vendorOf("stealth-1"), "stealth");
  assert.equal(vendorOf("foo3-bar"), "foo");
  assert.equal(vendorOf("owl-alpha"), "owl");
});

test("vendorOf：不匹配与空值归「其他」", () => {
  assert.equal(vendorOf(""), "其他");
  assert.equal(vendorOf("  "), "其他");
  assert.equal(vendorOf("-weird"), "其他");
  assert.equal(vendorOf("/leading-slash"), "其他");
});

test("groupModelsByVendor：分组排序，其他恒末", () => {
  const groups = groupModelsByVendor([
    "gemini-3.5-flash",
    "-odd",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "claude-opus-4",
  ]);
  assert.deepStrictEqual(
    groups.map((g) => g.vendor),
    ["claude", "gemini", "openai", "其他"],
  );
  const gpt = groups.find((g) => g.vendor === "openai")!;
  assert.deepStrictEqual(gpt.models, ["gpt-5.6-luna", "gpt-5.6-sol"]);
});

test("groupModelsByVendor：筛选大小写不敏感、空组不产出", () => {
  const groups = groupModelsByVendor(
    ["gpt-5.6-sol", "gemini-3.5-flash"],
    "GEMINI",
  );
  assert.deepStrictEqual(groups, [
    { vendor: "gemini", models: ["gemini-3.5-flash"] },
  ]);
});

test("visibleVendorGroups：全部保留分组，指定厂商只留该组", () => {
  const ids = ["gpt-5.6-sol", "gpt-5.4", "deepseek-v4-flash", "claude-opus-4"];
  assert.deepEqual(
    visibleVendorGroups(ids, "all").map((g) => g.vendor),
    ["claude", "deepseek", "openai"],
  );
  assert.deepEqual(visibleVendorGroups(ids, "openai").map((g) => g.models), [
    ["gpt-5.4", "gpt-5.6-sol"],
  ]);
  assert.deepEqual(visibleVendorGroups(ids, "openai", "5.4").map((g) => g.models), [
    ["gpt-5.4"],
  ]);
  assert.equal(visibleVendorGroups(ids, "missing").length, 0);
});
