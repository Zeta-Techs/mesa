import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASIDE_FALLBACK_CHAR_CAP,
  ASIDE_HISTORY_LIMIT,
  ASIDE_NEW_THREAD_TITLE,
  ASIDE_PANE_MAX_WIDTH,
  ASIDE_PANE_MIN_WIDTH,
  asideMethodHint,
  asideModeBadge,
  asideThreadTitleFromQuestion,
  buildFallbackTranscript,
  canAskAside,
  clampAsidePaneWidth,
  createAsideThread,
  parseBtwInput,
  removeAsideThread,
  summarizeAsidePane,
  toAsideHistory,
  type AsideTurn,
} from "../src/chat-aside.ts";
import type { ChatMessageDto } from "../src/types.ts";

describe("parseBtwInput", () => {
  it("bare /btw opens the side-question pane", () => {
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

describe("multi-thread management & pane geometry", () => {
  it("generates compact single-line thread titles from first question", () => {
    assert.equal(asideThreadTitleFromQuestion("   "), ASIDE_NEW_THREAD_TITLE);
    assert.equal(asideThreadTitleFromQuestion("为什么改了\n这个列名？"), "为什么改了 这个列名？");
    const long = "请帮我详细核对一下这段代码里为什么会出现竞态条件问题";
    const title = asideThreadTitleFromQuestion(long, 12);
    assert.equal(title, "请帮我详细核对一下这段代…");
  });

  it("removes active or inactive threads cleanly and reports empty when last removed", () => {
    const t1 = createAsideThread("sq-1");
    const t2 = createAsideThread("sq-2");
    const t3 = createAsideThread("sq-3");

    const r1 = removeAsideThread([t1, t2, t3], "sq-2", "sq-2");
    assert.deepEqual(
      r1.threads.map((t) => t.id),
      ["sq-1", "sq-3"],
    );
    assert.equal(r1.activeId, "sq-3");

    const r2 = removeAsideThread(r1.threads, "sq-3", "sq-1");
    assert.deepEqual(
      r2.threads.map((t) => t.id),
      ["sq-3"],
    );
    assert.equal(r2.activeId, "sq-3");

    const r3 = removeAsideThread(r2.threads, "sq-3", "sq-3");
    assert.deepEqual(r3.threads, []);
    assert.equal(r3.activeId, null);
  });

  it("clamps pane width against min, max, and half-container budget", () => {
    assert.equal(clampAsidePaneWidth(100, 1400), ASIDE_PANE_MIN_WIDTH);
    assert.equal(clampAsidePaneWidth(999, 1400), ASIDE_PANE_MAX_WIDTH);
    assert.equal(clampAsidePaneWidth(500, 800), 416); // 52% of 800
  });

  it("summarizes active and busy threads for the top bar indicator", () => {
    const empty = createAsideThread("sq-1");
    const busy = { ...createAsideThread("sq-2"), pendingQuestion: "做到哪了？" };
    const answered = {
      ...createAsideThread("sq-3"),
      turns: [
        {
          id: "1",
          question: "Q",
          answer: "A",
          how: "fork",
          costUsd: null,
          responderAgent: "claude-code",
          responderProfile: null,
        },
      ],
    };
    assert.deepEqual(summarizeAsidePane(false, [empty]), { open: false, activeThreads: 0, busy: false });
    assert.deepEqual(summarizeAsidePane(true, [empty, busy, answered]), {
      open: true,
      activeThreads: 2,
      busy: true,
    });
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
    assert.match(asideMethodHint("codex"), /Codex 只读副本/);
    assert.match(asideMethodHint("kimi"), /Kimi Code 只读副本/);
    assert.match(asideMethodHint("grok"), /Grok Build 只读副本/);
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
