import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASIDE_FALLBACK_CHAR_CAP,
  ASIDE_HISTORY_LIMIT,
  asideMethodHint,
  asideModeBadge,
  buildFallbackTranscript,
  canAskAside,
  parseBtwInput,
  toAsideHistory,
  type AsideTurn,
} from "../src/chat-aside.ts";
import type { ChatMessageDto } from "../src/types.ts";

describe("parseBtwInput", () => {
  it("bare /btw opens the side-question card", () => {
    assert.deepEqual(parseBtwInput("/btw"), { kind: "open" });
    assert.deepEqual(parseBtwInput("  /BTW   "), { kind: "open" });
  });

  it("/btw with a question extracts the question (space or newline)", () => {
    assert.deepEqual(parseBtwInput("/btw 做到哪了？"), { kind: "ask", question: "做到哪了？" });
    assert.deepEqual(parseBtwInput("/BTW\n为什么改了这个接口？"), {
      kind: "ask",
      question: "为什么改了这个接口？",
    });
  });

  it("ignores non-/btw messages and commands with extra prefix characters", () => {
    assert.equal(parseBtwInput("普通消息 /btw 放中间不算"), null);
    assert.equal(parseBtwInput("/btwx 不是这个命令"), null);
    assert.equal(parseBtwInput("/compact"), null);
    assert.equal(parseBtwInput(""), null);
  });
});

describe("canAskAside & hints", () => {
  it("blocks empty chats and allows chats with session, file, or messages", () => {
    const empty = canAskAside({ sessionId: null, filePath: null, messageCount: 0 });
    assert.equal(empty.ok, false);
    assert.deepEqual(canAskAside({ sessionId: "sid-1", filePath: null, messageCount: 0 }), { ok: true });
    assert.deepEqual(canAskAside({ sessionId: null, filePath: "/tmp/a.jsonl", messageCount: 0 }), { ok: true });
    assert.deepEqual(canAskAside({ sessionId: null, filePath: null, messageCount: 1 }), { ok: true });
  });

  it("returns tailored hints per agent family", () => {
    assert.match(asideMethodHint("claude-code"), /只读分身/);
    assert.match(asideMethodHint("codex"), /同一条连接只读回答/);
    assert.match(asideMethodHint("kimi"), /同一条连接只读回答/);
    assert.match(asideMethodHint("grok"), /同一条连接只读回答/);
    assert.match(asideMethodHint("gemini"), /代答/);
    assert.match(asideMethodHint("agy"), /代答/);
  });

  it("formats mode badges for all four backend paths", () => {
    assert.equal(asideModeBadge("fork", "claude-code", "Claude").label, "只读分身");
    assert.equal(asideModeBadge("copy", "codex", "Codex").label, "只读副本");
    assert.equal(asideModeBadge("delegate", "kimi", "Kimi Pro").label, "Kimi Code 代答");
    assert.match(asideModeBadge("delegate", "kimi", "Kimi Pro").title, /Kimi Pro/);
    assert.equal(asideModeBadge("text", "gemini", "Gemini").label, "按记录答");
  });
});

describe("toAsideHistory & buildFallbackTranscript", () => {
  it("keeps only the most recent non-empty turns up to limit", () => {
    const turns: AsideTurn[] = Array.from({ length: ASIDE_HISTORY_LIMIT + 3 }, (_, i) => ({
      id: `t-${i}`,
      question: `Q${i}`,
      answer: `A${i}`,
      how: "fork",
      costUsd: null,
      responderAgent: "claude-code",
      responderProfile: null,
    }));
    turns.push({
      id: "empty",
      question: "  ",
      answer: "ignored",
      how: "fork",
      costUsd: null,
      responderAgent: null,
      responderProfile: null,
    });
    const hist = toAsideHistory(turns);
    assert.equal(hist.length, ASIDE_HISTORY_LIMIT);
    assert.equal(hist[0].question, "Q3");
    assert.equal(hist[hist.length - 1].question, `Q${ASIDE_HISTORY_LIMIT + 2}`);
  });

  it("builds trimmed fallback transcript from visible messages", () => {
    assert.equal(buildFallbackTranscript([]), null);
    const msgs: ChatMessageDto[] = [
      {
        role: "user",
        timestamp: null,
        blocks: [{ kind: "text", text: "帮我检查一下登录流程" }],
      },
      {
        role: "assistant",
        timestamp: null,
        blocks: [
          { kind: "thinking", text: "内部思考不拼接" },
          { kind: "text", text: "好的，正在查看 auth.ts" },
        ],
      },
    ];
    const transcript = buildFallbackTranscript(msgs);
    assert.ok(transcript);
    assert.match(transcript, /## 用户\n帮我检查一下登录流程/);
    assert.match(transcript, /## 助手\n好的，正在查看 auth\.ts/);
    assert.doesNotMatch(transcript, /内部思考/);

    const huge: ChatMessageDto[] = [
      {
        role: "assistant",
        timestamp: null,
        blocks: [{ kind: "text", text: `${"早".repeat(ASIDE_FALLBACK_CHAR_CAP + 50)}尾部内容` }],
      },
    ];
    const clipped = buildFallbackTranscript(huge);
    assert.ok(clipped);
    assert.match(clipped, /更早的略/);
    assert.ok(clipped.endsWith("尾部内容"));
  });
});
