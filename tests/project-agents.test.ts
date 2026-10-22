import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectAgentRoster,
  currentProfileLine,
  projectAgentLaunch,
  projectAgentPrefs,
  projectAgentsEmptyWorkHint,
  projectAgentsHint,
  projectNeedsDefaultAgent,
  projectBoundProfileId,
  resolveProfileModel,
  resolvedTaskAgentId,
  taskBindingLaunch,
  resolveTaskModel,
  slotPrefs,
  CHAT_BINDING_SLOT,
  DISCUSS_BINDING_SLOT,
  stepSlotKey,
  resolveStepLaunch,
  workspaceLaunchChain,
  goalBoundLaunch,
} from "../src/project-agents.ts";
import { declaredTaskKindsForMode, taskStatusLabel } from "../src/project-tasks.ts";

const catalog = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini CLI" },
];

const profiles = [
  { id: "p-claude", agent: "claude-code", name: "中转 A", models: ["sonnet"] },
  { id: "p-codex", agent: "codex", name: "官方", models: ["gpt-5"] },
  { id: "p-codex-2", agent: "codex", name: "网关", models: ["gpt-5-mini"] },
];

function task(
  partial: Partial<{
    id: string;
    name: string;
    status: string;
    kind: string;
    agent: string | null;
    inputPaths: string[];
    declared: boolean;
  }>,
) {
  return {
    id: "t1",
    name: "整理筛选清单",
    status: "pending",
    kind: "free_research",
    agent: "codex",
    inputPaths: ["papers/included.md"],
    declared: true,
    ...partial,
  };
}

test("resolvedTaskAgentId prefers the step agent over project default", () => {
  assert.equal(resolvedTaskAgentId({ agent: "codex" }, "claude-code"), "codex");
  assert.equal(resolvedTaskAgentId({ agent: null }, "claude-code"), "claude-code");
  assert.equal(resolvedTaskAgentId({ agent: "  " }, null), "");
});

test("roster lists every configured agent with its own default profile", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: { "claude-code": "p-claude", codex: "p-codex-2" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  assert.deepEqual(
    rows.map((row) => ({
      id: row.agentId,
      isDefault: row.isProjectDefault,
      profile: row.defaultProfileId,
    })),
    [
      { id: "codex", isDefault: true, profile: "p-codex-2" },
      { id: "claude-code", isDefault: false, profile: "p-claude" },
    ],
  );
  assert.equal(unassigned.length, 0);
  assert.equal(rows.find((row) => row.agentId === "codex")?.profiles.length, 2);
});

test("declared tasks attach to the assigned agent and show status", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "claude-code",
    defaultProfiles: {},
    tasks: [
      task({ id: "a", agent: "codex", inputPaths: ["notes"] }),
      task({
        id: "b",
        name: "起草回复",
        agent: null,
        inputPaths: [],
        kind: "office_doc",
      }),
      task({
        id: "junk",
        name: "/Users/me/proj",
        declared: false,
        agent: "codex",
      }),
    ],
    taskKinds: new Set(["free_research", "office_doc"]),
  });
  const codex = rows.find((row) => row.agentId === "codex");
  const claude = rows.find((row) => row.agentId === "claude-code");
  assert.deepEqual(codex?.works.map((work) => `${work.name}:${work.statusLabel}`), [
    "整理筛选清单:尚未开始",
  ]);
  assert.deepEqual(claude?.works.map((work) => `${work.name}:${work.statusLabel}`), [
    "起草回复:尚未开始",
  ]);
  assert.equal(unassigned.length, 0);
});

test("tasks without an agent stay unassigned when the project has no default", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: null,
    defaultProfiles: {},
    tasks: [task({ agent: null })],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  assert.equal(
    rows.every((row) => row.works.length === 0),
    true,
  );
  assert.deepEqual(
    unassigned.map((work) => work.name),
    ["整理筛选清单"],
  );
});

test("coding projects still get a roster but no declared-task kinds", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: {},
    tasks: [task({})],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.equal(rows.some((row) => row.works.length > 0), false);
  assert.equal(declaredTaskKindsForMode("coding").size, 0);
});

test("hidden profiles stay visible when they are this project's default", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: ["p-codex-2"],
    defaultAgent: "codex",
    defaultProfiles: { codex: "p-codex-2" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("office"),
  });
  const codex = rows.find((row) => row.agentId === "codex");
  assert.equal(codex?.profiles.some((profile) => profile.id === "p-codex-2"), true);
});

test("an assigned agent still appears even if it currently has no connection", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: profiles.filter((profile) => profile.agent !== "gemini"),
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: {},
    tasks: [task({ agent: "gemini" })],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  const gemini = rows.find((row) => row.agentId === "gemini");
  assert.equal(gemini?.label, "Gemini CLI");
  assert.equal(gemini?.profiles.length, 0);
  assert.equal(gemini?.works[0]?.name, "整理筛选清单");
});

test("hints stay short and never promise routing", () => {
  for (const mode of ["office", "coding", "research"]) {
    assert.equal(projectAgentsHint(mode), "默认选择仅对本项目生效。");
  }
  assert.equal(projectNeedsDefaultAgent({ defaultAgent: "" }), true);
  assert.equal(projectNeedsDefaultAgent({ defaultAgent: "claude" }), false);
  assert.equal(projectAgentsEmptyWorkHint("research"), "新建目标或开步时指定谁干。");
  assert.equal(projectAgentsEmptyWorkHint("office"), "新建目标时指定谁写文档。");
  assert.equal(projectAgentsEmptyWorkHint("coding"), "在工作树里选谁开工。");
  assert.equal(taskStatusLabel("pending_review"), "待验收");
  assert.equal(taskStatusLabel("running"), "进行中");
});

test("currentProfileLine shows the project pick, else the first connection", () => {
  assert.equal(
    currentProfileLine({
      defaultProfileId: "p-codex-2",
      profiles: [
        { id: "p-codex", name: "官方", model: "gpt-5", modelLine: "官方 · gpt-5" },
        { id: "p-codex-2", name: "网关", model: "gpt-5-mini", modelLine: "网关 · gpt-5-mini" },
      ],
    }),
    "网关 · gpt-5-mini",
  );
  assert.equal(
    currentProfileLine({
      defaultProfileId: "",
      profiles: [{ id: "p-codex", name: "官方", model: "gpt-5", modelLine: "官方 · gpt-5" }],
    }),
    "官方 · gpt-5",
  );
  assert.equal(currentProfileLine({ defaultProfileId: "", profiles: [] }), null);
});

test("projectBoundProfileId uses the project binding for that agent", () => {
  const bound = { kimi: "p-kimi-a", "claude-code": "p-claude" };
  assert.equal(projectBoundProfileId(bound, "kimi"), "p-kimi-a");
  assert.equal(projectBoundProfileId(bound, "codex"), undefined);
  assert.equal(projectBoundProfileId({}, "kimi"), undefined);
  assert.equal(projectBoundProfileId({ kimi: "  " }, "kimi"), undefined);
});

test("projectAgentLaunch uses the Agents roster, not last launch", () => {
  assert.equal(projectAgentLaunch(profiles, null, { codex: "p-codex-2" }), null);
  assert.deepEqual(projectAgentLaunch(profiles, "codex", { codex: "p-codex-2" }), {
    agentId: "codex",
    profileId: "p-codex-2",
    model: "gpt-5-mini",
  });
  assert.equal(projectAgentLaunch(profiles, "codex", { codex: "gone" })?.profileId, "p-codex");
  assert.equal(projectAgentLaunch(profiles, "gemini", {}), null);
});

test("a connection lists every model, and the project pick wins over the first", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: [
      {
        id: "p-grok",
        agent: "codex",
        name: "Test",
        models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"],
      },
    ],
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: { codex: "p-grok" },
    defaultModels: { codex: "deepseek-v4.1-flash" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.deepEqual(
    rows[0].profiles.map((profile) => profile.model),
    ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"],
  );
  assert.equal(rows[0].defaultModelId, "deepseek-v4.1-flash");
  assert.equal(
    currentProfileLine(rows[0]),
    "Test · deepseek-v4.1-flash",
  );
  const launch = projectAgentLaunch(
    [{ id: "p-grok", agent: "codex", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
    "codex",
    { codex: "p-grok" },
    { codex: "deepseek-v4.1-flash" },
  );
  assert.equal(launch?.model, "deepseek-v4.1-flash");
  assert.equal(
    projectAgentLaunch(
      [{ id: "p-grok", agent: "codex", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
      "codex",
      { codex: "p-grok" },
      { codex: "gone" },
    )?.model,
    "deepseek-v4-flash-0731",
  );
  assert.equal(resolveProfileModel(["a", "b"], "b"), "b");
  assert.equal(resolveProfileModel(["a"], "gone"), "a");
  assert.deepEqual(
    projectAgentPrefs({
      defaultAgent: "codex",
      defaultProfiles: { codex: "p-grok" },
      defaultModels: { codex: "deepseek-v4.1-flash" },
    }),
    {
      preferredAgent: "codex",
      preferredProfile: "p-grok",
      preferredModel: "deepseek-v4.1-flash",
    },
  );
});

test("roster keeps connection names and models separate, including names with separators", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: [
      { id: "named", agent: "codex", name: "科研 · 精读", models: ["gpt-6-astra"] },
      { id: "default", agent: "codex", name: "CLI", models: [] },
    ],
    hiddenProfileIds: [],
    defaultAgent: null,
    defaultProfiles: {},
    tasks: [],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.deepEqual(rows[0].profiles.map(({ name, model }) => ({ name, model })), [
    { name: "科研 · 精读", model: "gpt-6-astra" },
    { name: "CLI", model: "CLI 默认" },
  ]);
});

test("taskBindingLaunch：绑定命中出三元组，失效/缺失回落 null，模型校验名单", () => {
  const profiles = [
    { id: "p1", agent: "claude-code", models: ["m-a", "m-b"] },
    { id: "p2", agent: "codex", models: [] },
  ];
  // 命中：agent 跟随连接、模型用绑定值
  assert.deepEqual(
    taskBindingLaunch(profiles, { profile: "p1", model: "m-b" }),
    { agentId: "claude-code", profileId: "p1", model: "m-b" },
  );
  // 模型不在名单：回落名单第一个；空名单给空串（CLI 默认）
  assert.deepEqual(
    taskBindingLaunch(profiles, { profile: "p1", model: "gone" }),
    { agentId: "claude-code", profileId: "p1", model: "m-a" },
  );
  assert.deepEqual(taskBindingLaunch(profiles, { profile: "p2" }), {
    agentId: "codex",
    profileId: "p2",
    model: "",
  });
  // 未绑定 / 连接被删 / 空串：null（调用方回落自动链）
  assert.equal(taskBindingLaunch(profiles, undefined), null);
  assert.equal(taskBindingLaunch(profiles, { profile: "deleted" }), null);
  assert.equal(taskBindingLaunch(profiles, { profile: "  " }), null);
});

test("stepSlotKey：step: 前缀拼接", () => {
  assert.equal(stepSlotKey("文献检索与筛选"), "step:文献检索与筛选");
});

test("resolveStepLaunch：步骤槽命中即用，未绑/失效回落项目默认三元组", () => {
  const profiles = [
    { id: "p1", agent: "claude-code", models: ["m-a"] },
    { id: "p2", agent: "codex", models: ["n-1", "n-2"] },
  ];
  const projectDefault = { agentId: "claude-code", profileId: "p1", model: "m-a" };
  // 命中：agent 跟随绑定连接、模型用绑定值
  assert.deepEqual(
    resolveStepLaunch(
      profiles,
      { "step:综述大纲": { profile: "p2", model: "n-2" } },
      "综述大纲",
      projectDefault,
    ),
    { agentId: "codex", profileId: "p2", model: "n-2" },
  );
  // 未绑：原样回落项目默认
  assert.equal(
    resolveStepLaunch(profiles, {}, "综述大纲", projectDefault),
    projectDefault,
  );
  // 绑定连接被删：回落项目默认（不报错）
  assert.equal(
    resolveStepLaunch(
      profiles,
      { "step:综述大纲": { profile: "gone" } },
      "综述大纲",
      projectDefault,
    ),
    projectDefault,
  );
  // 无绑定表也回落
  assert.equal(
    resolveStepLaunch(profiles, null, "综述大纲", projectDefault),
    projectDefault,
  );
});

test("workspaceLaunchChain：本次手选 > 步骤绑定 > 目录上次使用；缺层跳过", () => {
  const launch = { agentId: "a1", profileId: "pf1", model: "m1" };
  const stepL = { agentId: "a2", profileId: "pf2", model: "m2" };
  const last = { agentId: "a3", profileId: "pf3", model: "m3" };
  assert.deepEqual(workspaceLaunchChain(launch, stepL, last), launch);
  assert.deepEqual(workspaceLaunchChain(null, stepL, last), stepL);
  assert.deepEqual(workspaceLaunchChain(null, null, last), last);
  // 层内字段级缺省也要逐字段回落（弹层只给 agent 的场景不存在，但链是字段级的）
  assert.deepEqual(workspaceLaunchChain({ agentId: "x" }, stepL, last), {
    agentId: "x",
    profileId: "pf2",
    model: "m2",
  });
  assert.deepEqual(workspaceLaunchChain(null, null, null), {
    agentId: undefined,
    profileId: undefined,
    model: undefined,
  });
});

test("resolveTaskModel：目标绑定模型 > 命中项目默认连接取项目模型 > 名单第一（B2 三档回落）", () => {
  const models = ["m-a", "m-b"];
  // 目标绑定且在名单：直接用
  assert.equal(
    resolveTaskModel({ models, taskModel: "m-b", profileId: "p1", defaultProfileId: "p1", defaultModel: "m-a" }),
    "m-b",
  );
  // 目标绑定不在名单（连接换过名单）：命中项目默认连接 → 项目模型
  assert.equal(
    resolveTaskModel({ models, taskModel: "gone", profileId: "p1", defaultProfileId: "p1", defaultModel: "m-b" }),
    "m-b",
  );
  // 未绑 + 未命中项目默认连接：名单第一（不吃项目模型）
  assert.equal(
    resolveTaskModel({ models, taskModel: null, profileId: "p2", defaultProfileId: "p1", defaultModel: "m-b" }),
    "m-a",
  );
  // 命中项目默认连接但项目没点过模型：名单第一
  assert.equal(
    resolveTaskModel({ models, taskModel: null, profileId: "p1", defaultProfileId: "p1", defaultModel: null }),
    "m-a",
  );
  // 空名单：空串（CLI 默认）
  assert.equal(
    resolveTaskModel({ models: [], taskModel: null, profileId: "p1" }),
    "",
  );
});

test("slotPrefs：discuss 槽绑定命中出三件套，未绑原样回落项目默认（B4）", () => {
  const profiles = [
    { id: "p1", agent: "claude-code", models: ["m-a"] },
    { id: "p2", agent: "codex", models: ["n-1"] },
  ];
  const project = {
    defaultAgent: "claude-code",
    defaultProfiles: { "claude-code": "p1" },
    defaultModels: { "claude-code": "m-a" },
    taskBindings: { discuss: { profile: "p2", model: "n-1" } },
  };
  assert.deepEqual(slotPrefs(profiles, project, DISCUSS_BINDING_SLOT), {
    preferredAgent: "codex",
    preferredProfile: "p2",
    preferredModel: "n-1",
  });
  // 绑定连接被删 / 未绑：回落项目默认三件套
  const fallback = slotPrefs(
    profiles,
    { ...project, taskBindings: { discuss: { profile: "gone" } } },
    DISCUSS_BINDING_SLOT,
  );
  assert.deepEqual(fallback, { preferredAgent: "claude-code", preferredProfile: "p1", preferredModel: "m-a" });
  const unbound = slotPrefs(profiles, { ...project, taskBindings: {} }, DISCUSS_BINDING_SLOT);
  assert.deepEqual(unbound, { preferredAgent: "claude-code", preferredProfile: "p1", preferredModel: "m-a" });
  // 绑定未点模型：taskBindingLaunch 语义——回落该连接名单第一（n-1），不借项目默认的模型
  const noModel = slotPrefs(
    profiles,
    { ...project, taskBindings: { discuss: { profile: "p2" } } },
    DISCUSS_BINDING_SLOT,
  );
  assert.deepEqual(noModel, { preferredAgent: "codex", preferredProfile: "p2", preferredModel: "n-1" });
});

test("slotPrefs：项目对话槽与问 AI 槽互不借用", () => {
  const profiles = [
    { id: "p1", agent: "claude-code", models: ["m-a"] },
    { id: "p2", agent: "codex", models: ["n-1"] },
  ];
  const project = {
    defaultAgent: "claude-code",
    defaultProfiles: { "claude-code": "p1" },
    defaultModels: { "claude-code": "m-a" },
    taskBindings: {
      discuss: { profile: "p1", model: "m-a" },
      chat: { profile: "p2", model: "n-1" },
    },
  };
  assert.deepEqual(slotPrefs(profiles, project, CHAT_BINDING_SLOT), {
    preferredAgent: "codex",
    preferredProfile: "p2",
    preferredModel: "n-1",
  });
  assert.deepEqual(slotPrefs(profiles, project, DISCUSS_BINDING_SLOT).preferredAgent, "claude-code");
});


test("goalBoundLaunch：显式绑定尊重停用项，死引用 fail-loud，模型名单回落（W1 拍板①A）", () => {
  const profiles = [
    { id: "live", agent: "codex", models: ["m1", "m2"] },
    { id: "paused", agent: "claude-code", models: ["c1"] },
  ];
  // 无显式绑定 → null（调用方走既有回落链）
  assert.equal(goalBoundLaunch({ profiles, hiddenProfiles: [], profileId: null }), null);
  // 正常绑定：原样返回，无披露
  const ok = goalBoundLaunch({ profiles, hiddenProfiles: [], profileId: "live", model: "m2" });
  assert.deepEqual(ok, { kind: "bound", profileId: "live", agent: "codex", model: "m2", notes: [] });
  // 停用照用（①A：显式绑定尊重停用项）+ 披露一句
  const paused = goalBoundLaunch({ profiles, hiddenProfiles: ["paused"], profileId: "paused", model: "c1" });
  assert.equal(paused?.kind, "bound");
  if (paused?.kind === "bound") {
    assert.equal(paused.agent, "claude-code");
    assert.equal(paused.notes.length, 1);
    assert.match(paused.notes[0], /已停用/);
  }
  // 模型不在名单 → 回落名单第一 + 披露
  const stale = goalBoundLaunch({ profiles, hiddenProfiles: [], profileId: "live", model: "gone" });
  assert.equal(stale?.kind, "bound");
  if (stale?.kind === "bound") {
    assert.equal(stale.model, "m1");
    assert.match(stale.notes[0], /名单第一/);
  }
  // 死引用 → missing（fail-loud 交上层引导重绑，不静默换家）
  const dead = goalBoundLaunch({ profiles, hiddenProfiles: [], profileId: "deleted-x" });
  assert.deepEqual(dead, { kind: "missing", deadId: "deleted-x" });
});

test("聊天开聊前选项目：chat 槽 > 项目默认，都没有不动", async () => {
  const { projectChatLaunch } = await import("../src/project-agents.ts");
  const profiles = [
    { id: "cc1", agent: "claude-code", models: ["glm-5.3", "glm-5.3-flash"] },
    { id: "cx1", agent: "codex", models: ["gpt-5.5"] },
  ];
  assert.deepEqual(projectChatLaunch(profiles, { defaultAgent: "codex" }), {
    agentId: "codex",
    profileId: "cx1",
    model: "gpt-5.5",
  });
  assert.deepEqual(
    projectChatLaunch(profiles, {
      defaultAgent: "codex",
      taskBindings: { chat: { profile: "cc1", model: "glm-5.3-flash" } },
    }),
    { agentId: "claude-code", profileId: "cc1", model: "glm-5.3-flash" },
  );
  assert.equal(projectChatLaunch(profiles, {}), null);
  assert.equal(projectChatLaunch(profiles, null), null);
});

test("没绑连接的目标按项目默认解析：项目定的连接 > 这家第一条 > Claude Code > 任意", async () => {
  const { goalDefaultProfile } = await import("../src/project-agents.ts");
  const profiles = [
    { id: "cx-1", agent: "codex" },
    { id: "cx-2", agent: "codex" },
    { id: "cc-1", agent: "claude-code" },
  ];
  assert.equal(goalDefaultProfile(profiles, "codex", { codex: "cx-2" })?.id, "cx-2");
  assert.equal(goalDefaultProfile(profiles, "codex", {})?.id, "cx-1");
  assert.equal(goalDefaultProfile(profiles, "gemini", {})?.id, "cc-1");
  assert.equal(goalDefaultProfile(profiles, null, null)?.id, "cc-1");
  assert.equal(goalDefaultProfile([{ id: "g", agent: "gemini" }], null)?.id, "g");
});
