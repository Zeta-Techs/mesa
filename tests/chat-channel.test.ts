import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalChoices,
  approvalPreview,
  approvalTitle,
  channelAttention,
  channelSourceNote,
  channelOutcome,
  isQuestionApproval,
  channelCanAnswer,
  channelLiveLines,
  channelRelink,
  channelTurnOpen,
  displayCommand,
  hooksApprovalAnswered,
  channelInfersApproval,
  menuOutgrowsChannel,
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
  activity: null,
  thinking: null,
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

test("hooks 还说等批准、屏上已回到输入框：认作答过了；能从聊天层答的、不在等批准的不经这里", () => {
  const waiting = snap({ turn: turn("awaiting_approval"), approval: approval({ toolName: "WebFetch", kind: "fetch" }) });
  assert.equal(hooksApprovalAnswered(waiting, true), true);
  assert.equal(hooksApprovalAnswered(waiting, false), false, "屏上还挂着菜单 / 认不出输入框：照旧等");
  assert.equal(hooksApprovalAnswered(snap({ turn: turn("running") }), true), false);
  assert.equal(hooksApprovalAnswered(null, true), false);
  const codex = snap({
    agent: "codex",
    kind: "codex",
    turn: turn("awaiting_approval"),
    approval: approval({ requestId: "r1", replyable: true }),
  });
  assert.equal(hooksApprovalAnswered(codex, true), false);
  // 程序状态旁路（Grok，OSC 7501）与 hooks 同一口径：只说在等，答了没有看屏上
  const grok = snap({ agent: "grok", kind: "program-status", turn: turn("awaiting_approval"), approval: approval({}) });
  assert.equal(hooksApprovalAnswered(grok, true), true);
  assert.equal(channelInfersApproval(grok), true);
  assert.equal(channelInfersApproval(codex), false);
  assert.equal(channelInfersApproval(null), false);
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
  // Claude 计划模式出完方案（ExitPlanMode）：卡上给方案原文，不给参数 JSON
  const plan = approval({ toolName: "ExitPlanMode", kind: "other", plan: "# 方案", detail: '{"plan":"# 方案"}' });
  assert.deepEqual(approvalPreview(plan), { kind: "text", text: "# 方案" });
  assert.equal(approvalTitle(plan, "Claude Code"), "Claude Code 写好了方案，等你决定要不要开工");
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
    ["allow", "deny"],
  );
});

// 2026-10-26 用户截图（Qwen 0.26.1）：终端三项（多了「Switch to Default Mode and allow once (recommended)」），聊天卡只有允许 / 拒绝
test("终端菜单的选项比旁路能回的多，就改用照终端原文的菜单卡", () => {
  const qwen = snap({ agent: "qwen", kind: "qwen", turn: turn("awaiting_approval"), approval: approval({ replyable: true, requestId: "r" }) });
  assert.equal(menuOutgrowsChannel(qwen, "qwen", 3), true, "自动模式兜底多出一项");
  assert.equal(menuOutgrowsChannel(qwen, "qwen", 4), true, "平常的「总是允许」两项");
  assert.equal(menuOutgrowsChannel(qwen, "qwen", 2), false, "两项正好对上允许 / 拒绝");
  const codex = snap({ agent: "codex", kind: "codex", turn: turn("awaiting_approval"), approval: approval({ replyable: true, requestId: "r" }) });
  assert.equal(menuOutgrowsChannel(codex, "codex", 3), true, "命令前缀授权不能换成整个会话授权");
  assert.equal(menuOutgrowsChannel(codex, "codex", 2), true, "项数相同也按终端原文回答");
  assert.equal(menuOutgrowsChannel(codex, "codex", 0), false, "还没有菜单时只给单次允许和拒绝");
  assert.deepEqual(approvalChoices(approval({ replyable: true, requestId: "r" }), "opencode").map(c => c.decision), ["allow", "allow_always", "deny"]);
  // 旁路回不了 / 没有审批：本来就走菜单卡，不归这里管
  assert.equal(menuOutgrowsChannel(snap({ approval: approval({ replyable: false, requestId: "r" }) }), "claude-code", 4), false);
  assert.equal(menuOutgrowsChannel(snap(), "qwen", 4), false);
});

test("聊天卡上能答的审批不再拉起终端；只能在终端菜单里答的交回原来的判断", () => {
  const asking = (a: ChannelApproval) => snap({ agent: "codex", kind: "codex", turn: turn("awaiting_approval"), approval: a });
  assert.equal(channelCanAnswer(asking(approval({ replyable: true, requestId: "r" })), "codex"), true);
  assert.equal(channelCanAnswer(asking(approval({ replyable: false, requestId: "r" })), "claude-code"), false);
  assert.equal(channelCanAnswer(snap({ turn: turn("awaiting_approval") }), "codex"), false, "旁路没给审批内容");
  assert.equal(channelCanAnswer(null, "codex"), false);
});

test("审批卡上的命令剥掉外层 shell 包装", () => {
  // 2026-10-20 用户截图里 Codex 审批的原样
  assert.equal(
    displayCommand(`/bin/zsh -lc "/bin/zsh -lc 'printf \\"ok\\\\n\\" > ~/mesa-codex-check.txt'"`),
    `printf "ok\\n" > ~/mesa-codex-check.txt`,
  );
  assert.equal(displayCommand("bash -lc 'ls -la'"), "ls -la");
  assert.equal(displayCommand("rm -rf build"), "rm -rf build");
  // 外层 shell 先展开的不剥；包装后面还跟着别的也不剥
  assert.equal(displayCommand(`bash -c "echo $HOME"`), `bash -c "echo $HOME"`);
  assert.equal(displayCommand("sh -c 'a' && rm x"), "sh -c 'a' && rm x");
  assert.deepEqual(approvalPreview(approval({ command: "/bin/zsh -lc 'echo hi'" })), { kind: "command", text: "echo hi" });
  // Windows 上 Codex 包的是 PowerShell（2026-10-20 Windows 端到端实测的审批原文）
  assert.equal(
    displayCommand(`"D:\\PowerShell-7.6.7-win-x64\\pwsh.exe" -Command 'echo mesa > mesa_probe.txt'`),
    "echo mesa > mesa_probe.txt",
  );
  assert.equal(
    displayCommand(`C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command "Get-ChildItem src"`),
    "Get-ChildItem src",
  );
  assert.equal(displayCommand(`pwsh -Command 'it''s ok'`), "it's ok");
  // 双引号里有变量要外层先展开：不剥
  assert.equal(displayCommand(`pwsh -Command "echo $env:PATH"`), `pwsh -Command "echo $env:PATH"`);
});


test("只报 ID 的旁路换会话：已绑定文件也跟随，重复快照不重置", () => {
  for (const agent of ["qwen", "opencode"] as const) {
    const current = { filePath: "/p/a.json", sessionId: "a", hint: "a", seenSeq: 1 };
    const next = snap({ agent, kind: agent, sessionId: "b", sessionSeq: 2 });
    assert.deepEqual(channelRelink(next, current, false), { kind: "hint", sessionId: "b" });
    assert.deepEqual(channelRelink(next, { ...current, sessionId: "b", hint: "b" }, false), { kind: "none" });
    assert.deepEqual(channelRelink(next, { ...current, seenSeq: 2 }, false), { kind: "none" });
    assert.deepEqual(channelRelink(next, { ...current, filePath: null, hint: "b" }, false), { kind: "none" });
  }
});


test("旁路断开：旧回合与审批失去优先权，来源说明按本次连接显示", () => {
  const stale = snap({ connection: "disconnected", turn: turn("awaiting_approval"), liveText: "旧预览",
    sessionId: "a", transcriptPath: "/old", approval: approval({ requestId: "r", replyable: true }) });
  assert.equal(channelAttention(stale), null);
  assert.equal(channelTurnOpen(stale), false);
  assert.equal(channelLiveLines(stale), null);
  assert.equal(channelCanAnswer(stale, "codex"), false);
  assert.deepEqual(channelRelink(stale, { filePath: null, hint: null, seenSeq: 0 }, false), { kind: "none" });
  assert.match(channelSourceNote(stale), /已断开/);
  assert.match(channelSourceNote(null), /未接入/);
  assert.match(channelSourceNote(snap({ connection: "connecting" })), /正在连接/);
  assert.match(channelSourceNote(snap({ kind: "codex", connection: "connected" })), /已接入/);
});


test("回合失败与中断如实说明；提问不当作工具批准", () => {
  assert.match(channelOutcome(snap({ turn: { ...turn("failed"), error: "quota exceeded" } }))!, /未完成：quota exceeded/);
  assert.match(channelOutcome(snap({ turn: turn("cancelled") }))!, /已中断/);
  assert.equal(channelOutcome(snap({ turn: turn("completed") })), null);
  assert.equal(channelOutcome(snap({ connection: "disconnected", turn: turn("failed") })), null);
  for (const toolName of ["requestUserInput", "question", "elicitation"]) {
    const a = approval({ toolName, kind: "other", requestId: "q", replyable: false, detail: "选择哪一种？" });
    assert.equal(isQuestionApproval(a), true);
    assert.match(approvalTitle(a, "Codex"), /在等你回答/);
    assert.deepEqual(approvalChoices(a, "codex"), []);
    assert.deepEqual(approvalPreview(a), { kind: "text", text: "选择哪一种？" });
  }
  assert.equal(isQuestionApproval(approval()), false);
});
