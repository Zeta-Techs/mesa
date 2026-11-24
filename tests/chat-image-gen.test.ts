import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calledSince,
  captionsByPath,
  imageGenBlocks,
  imageGenDirective,
  imageGenIssue,
  producerOf,
  splitImageGenDirective,
  stripImageGenDirective,
  withImageGenDirective,
  type ImageGenCall,
} from "../src/chat-image-gen.ts";
import { userSaid } from "../src/chat-relay.ts";
import { userTextHistory } from "../src/composer-assist.ts";

test("出图模式发出去的第一行点名模型并写明出图工具", () => {
  assert.equal(
    imageGenDirective("gemini-3-pro-image", false),
    "使用 image-gen 技能出图（出图模型 gemini-3-pro-image，用 $MESA_IMAGE_TOOL 出图工具）：",
  );
  assert.ok(imageGenDirective(" gpt-image-2.5 ", true).startsWith("使用 image-gen 技能改图（出图模型 gpt-image-2.5，"));
});

test("拆回模型与人说的话；改图带原图行照样留在人话里", () => {
  const sent = withImageGenDirective("一只在实验台上的猫\n原图：/p/figures/cat.png", "doubao-seedream-4-0-250828", true);
  assert.deepEqual(splitImageGenDirective(sent), {
    model: "doubao-seedream-4-0-250828",
    models: ["doubao-seedream-4-0-250828"],
    compare: false,
    edit: true,
    said: "一只在实验台上的猫\n原图：/p/figures/cat.png",
  });
  assert.deepEqual(splitImageGenDirective(withImageGenDirective("封面", "vendor/flux-1.1", false)), {
    model: "vendor/flux-1.1",
    models: ["vendor/flux-1.1"],
    compare: false,
    edit: false,
    said: "封面",
  });
});

test("不是这一行写法的不拆：普通「使用 X 技能：」、句中提到、被改过的", () => {
  assert.equal(splitImageGenDirective("使用 image-gen 技能：画一只猫"), null);
  assert.equal(splitImageGenDirective("我想使用 image-gen 技能出图（出图模型 a）：画猫"), null);
  assert.equal(splitImageGenDirective("使用 image-gen 技能出图（随便）：\n画猫"), null);
  assert.equal(stripImageGenDirective("普通的一句话"), "普通的一句话");
});

test("取回历史、列表标题只要人说的那句（userSaid / userTextHistory）", () => {
  const sent = withImageGenDirective("画一张组会封面", "gpt-image-2.5", false);
  assert.equal(userSaid(sent), "画一张组会封面");
  const history = userTextHistory([
    { role: "user", blocks: [{ kind: "text", text: sent }] },
    { role: "assistant", blocks: [{ kind: "text", text: "好的" }] },
  ]);
  assert.deepEqual(history, ["画一张组会封面"]);
});

test("发之前查：没工具 > 没模型 > 没开技能；只有前两条拦发送", () => {
  const base = { helperReady: true, model: "gpt-image-2.5", candidates: 3, skillEnabled: true };
  assert.equal(imageGenIssue(base), null);
  assert.deepEqual(imageGenIssue({ ...base, helperReady: false, model: null }), { kind: "no-helper" });
  assert.deepEqual(imageGenIssue({ ...base, model: "  " }), { kind: "no-model", candidates: 3 });
  // 目录还没读回来：不说「网关里没有」
  assert.deepEqual(imageGenIssue({ ...base, model: null, candidates: null }), { kind: "no-model", candidates: null });
  assert.deepEqual(imageGenIssue({ ...base, skillEnabled: false }), { kind: "no-skill" });
  // 还没查回来（null）不当成没工具
  assert.equal(imageGenIssue({ ...base, helperReady: null }), null);
  assert.equal(imageGenBlocks({ kind: "no-helper" }), true);
  assert.equal(imageGenBlocks({ kind: "no-model", candidates: 0 }), true);
  assert.equal(imageGenBlocks({ kind: "no-skill" }), false);
  assert.equal(imageGenBlocks(null), false);
});

const call = (over: Partial<ImageGenCall>): ImageGenCall => ({
  id: "c1",
  at: 10_000,
  phase: "done",
  model: "gpt-image-2.5",
  gatewayName: "中转",
  paths: [],
  ...over,
});

test("这一轮有没有调过出图工具：开始那条就算，早于发出 2 秒以上的不算", () => {
  assert.equal(calledSince([], 10_000), false);
  assert.equal(calledSince([call({ at: 7_000 })], 10_000), false);
  assert.equal(calledSince([call({ at: 8_500, phase: "start" })], 10_000), true);
  assert.equal(calledSince([call({ at: 20_000, phase: "failed" })], 10_000), true);
});

test("图 → 模型：只认出成功的，同一路径后出的覆盖；Windows 折叠大小写与分隔符", () => {
  const map = captionsByPath(
    [
      call({ at: 2, model: "gemini-3-pro-image", paths: ["/p/figures/a.png"] }),
      call({ at: 1, model: "gpt-image-2.5", paths: ["/p/figures/a.png", "/p/figures/b.png"] }),
      call({ at: 3, phase: "start", model: "grok-imagine-image", paths: ["/p/figures/a.png"] }),
    ],
    false,
  );
  assert.equal(map.get("/p/figures/a.png"), "gemini-3-pro-image");
  assert.equal(map.get("/p/figures/b.png"), "gpt-image-2.5");
  const win = captionsByPath([call({ paths: ["C:\\P\\Figures\\A.png"] })], true);
  assert.equal(win.get("c:/p/figures/a.png"), "gpt-image-2.5");
});

test("几个模型对比：一行点名全部，写明各出一版；拆回来是模型列表", () => {
  const line = imageGenDirective(["gpt-image-2.5", " gemini-3-pro-image ", "doubao-seedream-4-0"], true);
  assert.equal(
    line,
    "使用 image-gen 技能改图（出图模型 gpt-image-2.5、gemini-3-pro-image、doubao-seedream-4-0 各出一版对比，用 $MESA_IMAGE_TOOL 出图工具）：",
  );
  const got = splitImageGenDirective(`${line}\n帽子换成蓝色\n原图：/p/a.png`);
  assert.deepEqual(got, {
    model: "gpt-image-2.5",
    models: ["gpt-image-2.5", "gemini-3-pro-image", "doubao-seedream-4-0"],
    compare: true,
    edit: true,
    said: "帽子换成蓝色\n原图：/p/a.png",
  });
  assert.equal(userSaid(`${line}\n帽子换成蓝色`), "帽子换成蓝色");
  // 只给一个就是平常写法
  assert.equal(imageGenDirective(["gpt-image-2.5"], false), imageGenDirective("gpt-image-2.5", false));
});

test("这张图是哪一次调用出的：取最后一次出成这张的，没出成或没记录为 null", () => {
  const calls = [
    call({ id: "a", at: 1, model: "gpt-image-2.5", gatewayName: "Codex", paths: ["/p/figures/cat-gpt.png"] }),
    call({ id: "b", at: 2, model: "gemini-3-pro-image", gatewayName: "Antigravity", paths: ["/p/figures/cat-gemini.png"] }),
    call({ id: "c", at: 3, phase: "failed", model: "grok-imagine-image", paths: ["/p/figures/cat-gemini.png"] }),
  ];
  assert.equal(producerOf(calls, "/p/figures/cat-gemini.png")?.model, "gemini-3-pro-image");
  assert.equal(producerOf(calls, "/p/figures/cat-gemini.png")?.gatewayName, "Antigravity");
  assert.equal(producerOf(calls, "/p/figures/other.png"), null);
  assert.equal(producerOf([call({ paths: ["C:\\P\\A.png"] })], "c:/p/a.png", true)?.model, "gpt-image-2.5");
});
