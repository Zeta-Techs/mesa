import assert from "node:assert/strict";
import test from "node:test";
import {
  codingTerminalLaunch,
  kickoffLaunchLabel,
  pickKickoffLaunch,
  kickoffLastKey,
  loadKickoffLast,
  saveKickoffLast,
} from "../src/kickoff-launch.ts";
import {
  expectedDeliverLine,
  expectedDeliverNames,
  formatKickoffChip,
  chipFileName,
  isDeclaredStepInput,
  isFlowDeclaredPath,
} from "../src/kickoff-inputs.ts";

const profiles = [
  { id: "p-claude", agent: "claude-code", name: "中转 A", models: ["sonnet"] },
  { id: "p-codex", agent: "codex", name: "官方", models: ["gpt-5"] },
];

test("pickKickoffLaunch：无连接返回 null", () => {
  assert.equal(pickKickoffLaunch([], null), null);
});

test("pickKickoffLaunch：优先记住的连接", () => {
  const picked = pickKickoffLaunch(profiles, {
    agentId: "codex",
    profileId: "p-codex",
    model: "gpt-5",
    useDefault: true,
  });
  assert.deepEqual(picked, {
    agentId: "codex",
    profileId: "p-codex",
    model: "gpt-5",
  });
});

test("pickKickoffLaunch：记住的连接已删则回落上次 Agent 的第一个", () => {
  const picked = pickKickoffLaunch(profiles, {
    agentId: "codex",
    profileId: "gone",
    model: "x",
    useDefault: true,
  });
  assert.equal(picked?.profileId, "p-codex");
});

test("pickKickoffLaunch：都没有则用列表第一个", () => {
  const picked = pickKickoffLaunch(profiles, null);
  assert.equal(picked?.profileId, "p-claude");
  assert.equal(picked?.model, "sonnet");
});

test("pickKickoffLaunch：项目点选的模型优先于问 AI 记忆", () => {
  const picked = pickKickoffLaunch(
    [{ id: "p-grok", agent: "grok", name: "Test", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
    { agentId: "grok", profileId: "p-grok", model: "deepseek-v4-flash-0731", useDefault: true },
    null,
    "grok",
    "p-grok",
    "deepseek-v4.1-flash",
  );
  assert.equal(picked?.model, "deepseek-v4.1-flash");
  assert.equal(
    codingTerminalLaunch(
      [{ id: "p-grok", agent: "grok", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
      null,
      "grok",
      "p-grok",
      "deepseek-v4.1-flash",
    )?.model,
    "deepseek-v4.1-flash",
  );
});

test("pickKickoffLaunch：项目默认 Agent 优先于全局记忆", () => {
  const picked = pickKickoffLaunch(
    profiles,
    {
      agentId: "codex",
      profileId: "p-codex",
      model: "gpt-5",
      useDefault: true,
    },
    null,
    "claude-code",
  );
  assert.equal(picked?.agentId, "claude-code");
  assert.equal(picked?.profileId, "p-claude");
});

test("codingTerminalLaunch：项目绑了 Agents 直接启动", () => {
  const launch = codingTerminalLaunch(profiles, null, "codex", "p-codex");
  assert.equal(launch?.autoStart, true);
  assert.equal(launch?.agentId, "codex");
  assert.equal(launch?.profileId, "p-codex");
});

test("codingTerminalLaunch：勾过默认才自动启动", () => {
  assert.equal(codingTerminalLaunch(profiles, null)?.autoStart, false);
  assert.equal(
    codingTerminalLaunch(profiles, {
      agentId: "codex",
      profileId: "p-codex",
      model: "gpt-5",
      useDefault: true,
    })?.autoStart,
    true,
  );
  assert.equal(
    codingTerminalLaunch(profiles, {
      agentId: "codex",
      profileId: "gone",
      model: "gpt-5",
      useDefault: true,
    })?.autoStart,
    false,
  );
});

test("kickoffLaunchLabel：没有连接时说人话", () => {
  assert.equal(
    kickoffLaunchLabel(null, profiles, (id) => id),
    "还没有可用连接",
  );
});

test("formatKickoffChip：included 用篇、缺的标还没有", () => {
  assert.deepEqual(
    formatKickoffChip({
      pattern: "papers/included.md",
      role: "required",
      present: true,
      count: 12,
    }),
    { label: "included.md · 12 篇", missing: false },
  );
  assert.deepEqual(
    formatKickoffChip({
      pattern: "notes/*.md",
      role: "required",
      present: true,
      count: 8,
    }),
    { label: "notes/ · 8 份", missing: false },
  );
  assert.equal(chipFileName("notes/*.md"), "notes/");
  assert.deepEqual(
    formatKickoffChip({
      pattern: "outline.md",
      role: "required",
      present: false,
      count: 0,
    }),
    { label: "outline.md · 还没有", missing: true },
  );
  assert.equal(
    formatKickoffChip({
      pattern: "notes/",
      role: "optional",
      present: false,
      count: 0,
    }),
    null,
  );
});

test("isDeclaredStepInput：精读步 papers/*.pdf 已在上一步接到，不算陌生未登记", () => {
  const notes = {
    inputs: ["papers/included.md", "papers/included.json", "papers/to-fetch.md"],
    optionalInputs: ["papers/*.pdf"],
  };
  assert.equal(
    isDeclaredStepInput(
      "papers/Ford2018-cross-linked-ionomer-gel-separators-for.pdf",
      notes,
    ),
    true,
  );
  assert.equal(isDeclaredStepInput("papers/included.md", notes), true);
  assert.equal(isDeclaredStepInput("notes/01-foo.md", notes), false);
  assert.equal(isDeclaredStepInput("data/raw.csv", notes), false);
  assert.equal(isDeclaredStepInput("papers/foo.pdf", { inputs: [] }), false);
});

test("isFlowDeclaredPath：全流水线口径，后续步骤不再整批重报 papers/ PDF", () => {
  // 英文综述模板的简化步骤链：检索 → 精读（声明 papers/*.pdf 可选输入）→ 综述大纲
  const steps = [
    {
      inputs: [] as string[],
      expectedArtifacts: [
        "papers/screening.md",
        "papers/included.md",
        "papers/to-fetch.md",
        "papers/to-fetch.ris",
      ],
    },
    {
      inputs: ["papers/included.md"],
      optionalInputs: ["papers/*.pdf"],
      expectedArtifacts: ["notes/*.md", "references.bib"],
    },
    {
      inputs: ["notes/", "papers/included.md", "references.bib"],
      expectedArtifacts: ["outline.md"],
    },
  ];
  // 综述大纲步自己的 inputs 不含 papers/*.pdf，但精读步声明过 → 不算陌生发现
  assert.equal(
    isFlowDeclaredPath("papers/Ford2018-ionomer-gel.pdf", steps),
    true,
  );
  // 检索步预期产物（.ris 会被资源扫描归类）也属流水线接管
  assert.equal(isFlowDeclaredPath("papers/to-fetch.ris", steps), true);
  assert.equal(isFlowDeclaredPath("references.bib", steps), true);
  // 真正的陌生文件（人工丢进 data/ 的数据、根下散落 PDF）仍要提醒
  assert.equal(isFlowDeclaredPath("data/raw.csv", steps), false);
  assert.equal(isFlowDeclaredPath("downloaded-paper.pdf", steps), false);
  // 空清单 / 空路径
  assert.equal(isFlowDeclaredPath("papers/foo.pdf", []), false);
  assert.equal(isFlowDeclaredPath("", steps), false);
});

test("expectedDeliverLine：列出本步产物短名", () => {
  assert.deepEqual(expectedDeliverNames(["notes/*.md", "references.bib"]), [
    "notes/",
    "references.bib",
  ]);
  assert.equal(
    expectedDeliverLine(["notes/*.md", "references.bib"]),
    "本步要交：notes/、references.bib",
  );
  assert.equal(expectedDeliverLine([]), "按任务书交付本步产物");
});

test("kickoffLast：项目级开工记忆往返与坏值回落（B1 与问 AI 记忆分键）", () => {
  // Node 测试无 localStorage：内存桩（reader.test 同款）
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    },
  });
  localStorage.clear();
  assert.equal(loadKickoffLast("/p/proj"), null);
  saveKickoffLast("/p/proj", { agentId: "claude-code", profileId: "pf", model: "m" });
  assert.equal(kickoffLastKey("/p/proj"), "ccode.kickoffLast./p/proj");
  assert.deepEqual(loadKickoffLast("/p/proj"), {
    agentId: "claude-code",
    profileId: "pf",
    model: "m",
  });
  // 坏 JSON / 缺字段按 null（不抛）
  localStorage.setItem("ccode.kickoffLast./p/bad", "{oops");
  assert.equal(loadKickoffLast("/p/bad"), null);
  localStorage.setItem("ccode.kickoffLast./p/half", JSON.stringify({ agentId: "a" }));
  assert.equal(loadKickoffLast("/p/half"), null);
});
