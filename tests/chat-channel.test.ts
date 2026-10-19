import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalChoices,
  approvalPreview,
  approvalTitle,
  channelAttention,
  channelLiveLines,
  channelRelink,
  channelTurnOpen,
  sessionSwitchNote,
  type ChannelApproval,
  type ChatChannelSnapshot,
} from "../src/chat-channel.ts";

const snap = (patch: Partial<ChatChannelSnapshot> = {}): ChatChannelSnapshot => ({
  tabId: "t1",
  agent: "claude-code",
  kind: "hooks",
  sessionId: null,
  transcriptPath: null,
  sessionSeq: 0,
  sessionSource: null,
  turn: null,
  approval: null,
  liveText: null,
  notice: null,
  ...patch,
});

const turn = (status: NonNullable<ChatChannelSnapshot["turn"]>["status"]) => ({
  seq: 1,
  status,
  stopReason: null,
  startedAt: 1,
  endedAt: status === "running" || status === "awaiting_approval" ? null : 2,
});

const approval = (patch: Partial<ChannelApproval> = {}): ChannelApproval => ({
  requestId: null,
  replyable: false,
  toolName: "Bash",
  kind: "execute",
  command: null,
  path: null,
  oldText: null,
  newText: null,
  diff: null,
  detail: null,
  alwaysLabel: null,
  ...patch,
});

test("回合状态 → 标签注意力；旁路没说过就交回原来的推断", () => {
  assert.equal(channelAttention(null), null);
  assert.equal(channelAttention(snap()), null);
  assert.equal(channelAttention(snap({ turn: turn("running") })), "working");
  assert.equal(channelAttention(snap({ turn: turn("awaiting_approval") })), "confirm");
  assert.equal(channelAttention(snap({ turn: turn("completed") })), "done");
  assert.equal(channelAttention(snap({ turn: turn("cancelled") })), "done");
  assert.equal(channelTurnOpen(snap({ turn: turn("awaiting_approval") })), true);
  assert.equal(channelTurnOpen(snap({ turn: turn("failed") })), false);
});

test("跟会话：直接给路径就锁定；/clear 换了文件就改盯；只给 id 交给按 id 找", () => {
  const cur = { filePath: null, hint: null, seenSeq: 0 };
  assert.deepEqual(channelRelink(snap({ sessionId: "a", transcriptPath: "/p/a.jsonl" }), cur, false), {
    kind: "lock",
    path: "/p/a.jsonl",
    sessionId: "a",
  });
  const linked = { filePath: "/p/a.jsonl", hint: null, seenSeq: 0 };
  assert.deepEqual(
    channelRelink(snap({ sessionId: "a", transcriptPath: "/p/a.jsonl" }), linked, false),
    { kind: "none" },
  );
  assert.deepEqual(
    channelRelink(snap({ sessionId: "b", transcriptPath: "/p/b.jsonl", sessionSeq: 1 }), linked, false),
    { kind: "switch", path: "/p/b.jsonl", sessionId: "b" },
  );
  // 同一次换过已经处理（seenSeq 跟上了）就不再切
  assert.deepEqual(
    channelRelink(snap({ sessionId: "b", transcriptPath: "/p/b.jsonl", sessionSeq: 1 }), { ...linked, seenSeq: 1 }, false),
    { kind: "none" },
  );
  assert.deepEqual(channelRelink(snap({ sessionId: "q1" }), cur, false), { kind: "hint", sessionId: "q1" });
  assert.deepEqual(channelRelink(snap({ sessionId: "q1" }), { ...cur, hint: "q1" }, false), { kind: "none" });
  assert.equal(sessionSwitchNote("clear"), "已开始新对话（/clear）");
});

test("实时文字按行给预览", () => {
  assert.equal(channelLiveLines(snap({ liveText: "x" })), null, "没有回合不当预览");
  assert.deepEqual(channelLiveLines(snap({ turn: turn("running"), liveText: "一\n二\n" })), ["一", "二"]);
});

test("审批卡：命令原文 / 要改的差异 / Codex 的统一差异", () => {
  assert.deepEqual(approvalPreview(approval({ command: "rm -rf build" })), { kind: "command", text: "rm -rf build" });
  const edit = approvalPreview(approval({ kind: "edit", path: "/w/a.ts", oldText: "x", newText: "y" }));
  assert.ok(edit && edit.kind === "diff");
  assert.deepEqual(
    edit.lines.map((l) => l.op),
    ["-", "+"],
  );
  const codex = approvalPreview(approval({ kind: "edit", path: "/w/a.txt", diff: "@@ -1 +1 @@\n+hello\n-bye" }));
  assert.ok(codex && codex.kind === "diff");
  assert.deepEqual(
    codex.lines.map((l) => [l.op, l.text]),
    [
      ["+", "hello"],
      ["-", "bye"],
    ],
  );
  const many = approvalPreview(approval({ kind: "edit", diff: "*** /w/a\n+1\n*** /w/b\n-2" }));
  assert.ok(many && many.kind === "diff");
  assert.deepEqual(many.lines.map((l) => l.op), ["~", "+", "~", "-"], "多个文件之间画分隔");
  assert.equal(approvalPreview(approval({ kind: "read", path: "/w/a" })), null);
  assert.equal(approvalTitle(approval({ kind: "edit", path: "/w/src/a.ts" }), "Claude Code"), "Claude Code 要改文件 · a.ts");
  assert.equal(approvalTitle(approval({ command: "ls" }), "Codex"), "Codex 要运行一条命令");
});

test("能从聊天层答的才给按钮；「都允许」只给支持的家", () => {
  assert.deepEqual(approvalChoices(approval({ replyable: false, requestId: "r" }), "claude-code"), []);
  assert.deepEqual(
    approvalChoices(approval({ replyable: true, requestId: "r" }), "qwen").map((c) => c.decision),
    ["allow", "deny"],
  );
  assert.deepEqual(
    approvalChoices(approval({ replyable: true, requestId: "r" }), "codex").map((c) => c.decision),
    ["allow", "allow_always", "deny"],
  );
});
