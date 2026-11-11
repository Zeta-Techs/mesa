import assert from "node:assert/strict";
import test from "node:test";
import {
  crossReviewPrompt,
  crossReviewDoneText,
  crossReviewReuseKey,
  modelFamily,
  pickCrossReviewer,
  producerFamilies,
  reviewerOptionLabel,
  reviewerOptions,
  stepHasClaims,
  type ReviewerProfile,
} from "../src/cross-review.ts";

const p = (
  id: string,
  agent: string,
  lastUsedAt: string | null,
  models: string[] = ["m-" + id],
  accountType: "api" | "official" = "api",
): ReviewerProfile => ({ id, agent, name: id, models, lastUsedAt, accountType });

test("模型族按模型名认、不认中转站；官方账号没写模型按 Agent 认，API 连接不猜", () => {
  assert.equal(modelFamily("claude-sonnet-4", "codex"), "anthropic");
  assert.equal(modelFamily("glm-5.3", "claude-code"), "zhipu");
  assert.equal(modelFamily("gpt-5", "kimi"), "openai");
  assert.equal(modelFamily("", "codex", "official"), "openai");
  assert.equal(modelFamily("", "codex", "api"), null);
  assert.equal(modelFamily("my-private-model", "claude-code"), null);
});

test("「不同」按模型族比：Claude Code 接 GLM 写稿，接 GLM 的 Codex 不算另一家", () => {
  const profiles = [
    p("cx-glm", "codex", "2026-11-02", ["glm-5.3"]),
    p("kimi", "kimi", "2026-10-01", ["kimi-k2"]),
    p("cc", "claude-code", "2026-11-01", ["glm-5.3"]),
  ];
  const producer = { agent: "claude-code", models: ["glm-5.3"] };
  assert.deepEqual([...producerFamilies(producer)], ["zhipu"]);
  const pick = pickCrossReviewer(profiles, [], producer)!;
  assert.equal(pick.agentId, "kimi");
  assert.equal(pick.model, "kimi-k2");
  // 下拉里同模型族的标出来，但不删掉
  const same = reviewerOptions(profiles, [], producer).find((o) => o.profileId === "cx-glm")!;
  assert.equal(same.sameFamily, true);
  assert.match(reviewerOptionLabel(same, "Codex"), /与写稿同一模型族/);
});

test("一条中转连接挂多家模型时取第一个模型族不同的；一等优先、最近用过的连接优先；一等里没有再看维护级", () => {
  const relay = p("relay", "codex", "2026-11-01", ["claude-opus-4", "gpt-5", "deepseek-v3"]);
  const producer = { agent: "claude-code", models: ["claude-opus-4"] };
  assert.equal(pickCrossReviewer([relay], [], producer)?.model, "gpt-5");
  const older = p("cx-old", "codex", "2026-09-01", ["gpt-5"]);
  assert.equal(pickCrossReviewer([older, relay], [], producer)?.profileId, "relay");
  // 一等里只有同模型族：从维护级挑，并标维护级
  const gem = p("gem", "gemini", null, ["gemini-2.5-pro"]);
  const onlyClaude = [p("cc2", "codex", null, ["claude-sonnet-4"]), gem];
  const pick = pickCrossReviewer(onlyClaude, [], producer)!;
  assert.equal(pick.agentId, "gemini");
  assert.match(reviewerOptionLabel(pick, "Gemini CLI"), /维护级，复核指令未在这家验证过/);
  // 停用的连接不出现
  assert.equal(reviewerOptions([relay], ["relay"], producer).length, 0);
});

test("写稿方模型认不出时退回按 Agent 判断；官方账号没写模型按 Agent 认模型族", () => {
  const profiles = [p("cc", "claude-code", null, ["x-1"]), p("cx", "codex", null, [], "official")];
  assert.equal(pickCrossReviewer(profiles, [], { agent: "claude-code", models: ["internal-model"] })?.agentId, "codex");
  assert.equal(pickCrossReviewer(profiles, [], null)?.agentId, "claude-code");
  const official = reviewerOptions(profiles, [], { agent: "codex", models: [], profile: profiles[1] });
  assert.equal(official.find((o) => o.profileId === "cx")?.sameFamily, true, "官方 Codex 写稿、官方 Codex 复核是同一模型族");
});

test("复核指令：只写一个核验文件、结论一律待你判断、不改稿件；标签与干活的分开", () => {
  const prompt = crossReviewPrompt("codex", "/proj");
  assert.match(prompt, /\.ccode\/checks\/cross-review\.jsonl/);
  assert.match(prompt, /"status": "needs_human"/);
  assert.match(prompt, /"checker": "agent:codex"/);
  assert.match(prompt, /不改稿件、不改其他任何文件、不提交/);
  // 2026-11-02 真跑：Codex 把临时文本抽到工作目录、写文件与 rm -f 拼一条被拦后没写成记录
  assert.match(prompt, /临时文件放系统临时目录/);
  assert.match(prompt, /每判断完一条就立刻往 \.ccode\/checks\/cross-review\.jsonl 追加一行/);
  assert.match(prompt, /一轮内做完/);
  // 2026-11-02 Claude Code / Kimi 真跑：两家对「支持」理解不一（摘录本身 vs 原文别处），Kimi 漏写 checker
  assert.match(prompt, /先看这段摘录本身是否支撑/);
  assert.match(prompt, /记「摘录不当」并在 detail 写出原文里真正支撑的那句与页码/);
  assert.match(prompt, /每个字段都要写，checker 照上面原样写/);
  assert.match(prompt, /\/proj\/papers\//);
  assert.equal(crossReviewReuseKey("/wt/a"), "cross-review:/wt/a");
  assert.ok(!crossReviewReuseKey("/wt/a").startsWith("ws:"));
});

test("一等 Agent 名单与后端能力表同一份（AGENTS.md「CLI 支持分级」）", async () => {
  const { readFileSync } = await import("node:fs");
  const { TIER1_AGENTS } = await import("../src/cross-review.ts");
  const rust = readFileSync("src-tauri/src/agent_specs.rs", "utf8");
  const m = rust.match(/TIER1_AGENTS: \[&str; \d+\] = \[([^\]]+)\]/);
  assert.ok(m, "agent_specs.rs 里找不到 TIER1_AGENTS");
  assert.deepEqual(m[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean), [...TIER1_AGENTS]);
});

test("复核按钮只挂在写带引用正文的步骤上：稿件、开题、章节、报告算，检索、精读、数据步不算", () => {
  assert.equal(stepHasClaims(["manuscript/review-final.md", "output/review-final.pdf"]), true);
  assert.equal(stepHasClaims(["manuscript/chapters/*.tex"]), true);
  assert.equal(stepHasClaims(["proposal/proposal.md"]), true);
  assert.equal(stepHasClaims(["analysis-report.md", "analysis/numbers.json"]), true);
  assert.equal(stepHasClaims(["papers/screening.md", "papers/included.md", "papers/included.json"]), false);
  assert.equal(stepHasClaims(["notes/*.md", "notes/index.json", "references.bib"]), false);
  assert.equal(stepHasClaims(["data-dictionary.md", "data/fields.json"]), false);
  assert.equal(stepHasClaims(undefined), false);
  // 大纲步一并交写作规范：它不是稿件，大纲不挂复核
  assert.equal(stepHasClaims(["outline.md", "manuscript/sections.json", "manuscript/style-sheet.md"]), false);
});

test("复核说完的提示：数复核方记的条目，全是无法判断时点明多半没找到正文", () => {
  const x = (title: string) => ({ kind: "claim_support", checker: "agent:codex", title });
  assert.match(crossReviewDoneText([]), /没往核验清单里记东西/);
  assert.match(crossReviewDoneText([{ kind: "outline-coverage", checker: "mesa", title: "t" }]), /没往核验清单里记东西/);
  assert.match(crossReviewDoneText([x("无法判断：未找到正文")]), /1 条「无法判断」/);
  assert.equal(crossReviewDoneText([x("[@A] 不支持：…"), x("无法判断：…")]), "复核说完了：核验清单里多了 2 条待你判断");
});
