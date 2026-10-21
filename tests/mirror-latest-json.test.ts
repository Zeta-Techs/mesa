import assert from "node:assert/strict";
import test from "node:test";
import {
  keyPrefixFromBase,
  normalizeMirrorBase,
  rewriteLatestJson,
} from "../scripts/mirror-latest-json.mjs";

const latest = {
  version: "1.2.3",
  notes: "更新说明",
  pub_date: "2026-10-21T00:00:00Z",
  platforms: {
    "windows-x86_64": {
      signature: "sig-win",
      url: "https://github.com/hongtongzhou-design/ccode/releases/download/v1.2.3/Mesa_1.2.3_x64-setup.exe",
    },
    "darwin-aarch64": {
      signature: "sig-arm",
      url: "https://github.com/hongtongzhou-design/ccode/releases/download/v1.2.3/Mesa_aarch64.app.tar.gz",
    },
    "darwin-x86_64": {
      signature: "sig-x64",
      url: "https://github.com/hongtongzhou-design/ccode/releases/download/v1.2.3/Mesa_x64.app.tar.gz",
    },
  },
};

test("镜像清单：下载地址换成「镜像根/tag/文件名」，签名与其余字段原样", () => {
  const { manifest, files } = rewriteLatestJson(latest, "https://dl.example.com/mesa/", "v1.2.3");
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    "https://dl.example.com/mesa/v1.2.3/Mesa_1.2.3_x64-setup.exe",
  );
  assert.equal(manifest.platforms["darwin-x86_64"].url, "https://dl.example.com/mesa/v1.2.3/Mesa_x64.app.tar.gz");
  for (const p of Object.keys(latest.platforms)) {
    assert.equal(manifest.platforms[p].signature, latest.platforms[p].signature, "签名不能动");
  }
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.notes, "更新说明");
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => f.url.startsWith("https://github.com/")));
  // 原清单不被改
  assert.ok(latest.platforms["windows-x86_64"].url.startsWith("https://github.com/"));
});

test("镜像清单：缺签名、非 https、怪 tag 一律拒绝", () => {
  const unsigned = structuredClone(latest);
  delete unsigned.platforms["darwin-aarch64"].signature;
  assert.throws(() => rewriteLatestJson(unsigned, "https://dl.example.com", "v1.2.3"), /签名/);
  assert.throws(() => rewriteLatestJson(latest, "http://dl.example.com", "v1.2.3"), /https/);
  assert.throws(() => rewriteLatestJson(latest, "https://dl.example.com", "v1/../x"), /tag/);
  assert.throws(() => rewriteLatestJson({ platforms: {} }, "https://dl.example.com", "v1"), /没有任何平台/);
});

test("对象路径前缀跟镜像根地址的路径走", () => {
  assert.equal(keyPrefixFromBase("https://dl.example.com/mesa"), "mesa/");
  assert.equal(keyPrefixFromBase("https://dl.example.com/a/b/"), "a/b/");
  assert.equal(keyPrefixFromBase("https://dl.example.com"), "");
  assert.equal(normalizeMirrorBase(" https://dl.example.com/mesa// "), "https://dl.example.com/mesa");
});
