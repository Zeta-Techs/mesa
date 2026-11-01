import assert from "node:assert/strict";
import test from "node:test";
import { crossReviewPrompt, crossReviewReuseKey, pickCrossReviewer, type ReviewerProfile } from "../src/cross-review.ts";

const p = (id: string, agent: string, lastUsedAt: string | null, models: string[] = ["m-" + id]): ReviewerProfile => ({
  id,
  agent,
  name: id,
  models,
  lastUsedAt,
});

test("复核挑另一家一等支持的 Agent：跳过干活的那家、停用的连接与维护级 Agent，同家挑最近用过的", () => {
  const profiles = [
    p("cc-old", "claude-code", "2026-10-01"),
    p("cc-new", "claude-code", "2026-11-01"),
    p("codex", "codex", null),
    p("gem", "gemini", "2026-11-02"),
    p("kimi", "kimi", "2026-11-02"),
  ];
  assert.deepEqual(pickCrossReviewer(profiles, [], "codex"), {
    agentId: "claude-code",
    profileId: "cc-new",
    model: "m-cc-new",
    profileName: "cc-new",
  });
  assert.equal(pickCrossReviewer(profiles, [], "claude-code")?.agentId, "codex");
  assert.equal(pickCrossReviewer(profiles, ["codex"], "claude-code")?.agentId, "kimi");
  // 干活的是维护级 Agent（如 Gemini）时照样从一等里挑
  assert.equal(pickCrossReviewer(profiles, [], "gemini")?.agentId, "claude-code");
  // 只有干活那一家与维护级：没有可复核的
  assert.equal(pickCrossReviewer([p("cc", "claude-code", null), p("gem", "gemini", null)], [], "claude-code"), null);
  // 官方账号没有模型名单：模型留空交给启动栏默认
  assert.equal(pickCrossReviewer([p("cx", "codex", null, [])], [], null)?.model, "");
});

test("复核指令：只写一个核验文件、结论一律待你判断、不改稿件；标签与干活的分开", () => {
  const prompt = crossReviewPrompt("codex", "/proj");
  assert.match(prompt, /\.ccode\/checks\/cross-review\.jsonl/);
  assert.match(prompt, /"status": "needs_human"/);
  assert.match(prompt, /"checker": "agent:codex"/);
  assert.match(prompt, /不改稿件、不改其他任何文件、不提交/);
  assert.match(prompt, /\/proj\/papers\//);
  assert.equal(crossReviewReuseKey("/wt/a"), "cross-review:/wt/a");
  assert.ok(!crossReviewReuseKey("/wt/a").startsWith("ws:"));
});
