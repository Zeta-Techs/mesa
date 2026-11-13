import assert from "node:assert/strict";
import test from "node:test";
import {
  chatPermissionMemoryApplies,
  nextPermissionTier,
  permissionExample,
  profilePermissionMode,
  rememberChatPermission,
  rememberedFullAccess,
} from "../src/chat-permission.ts";

test("权限示例按项目类型取，四档都有一句", () => {
  const coding = permissionExample("coding");
  assert.equal(coding.target, "npm test");
  assert.equal(coding.outcomes.full, "直接跑，删文件也不问");
  assert.equal(permissionExample("research").target, "manuscript/draft.md");
  assert.equal(permissionExample("office").outcomes.auto, "直接改；删文件这类才问");
  const general = permissionExample("general");
  for (const id of ["discuss", "ask", "auto", "full"] as const) assert.ok(general.outcomes[id]);
});

test("先出方案（原「只讨论」）：Claude Code / CodeBuddy / Gemini / Kimi / Qwen / OpenCode 是计划模式，写成「方案你点头了再…」；其余各家照旧", () => {
  for (const agent of ["codebuddy", "gemini", "kimi", "qwen", "opencode"]) {
    assert.equal(permissionExample("coding", agent).outcomes.discuss, "方案你点头了再跑", agent);
  }
  for (const agent of ["grok", "cursor"]) {
    assert.equal(permissionExample("coding", agent).outcomes.discuss, "不跑，告诉你怎么跑", agent);
  }
  assert.equal(permissionExample("coding", "claude-code").outcomes.discuss, "方案你点头了再跑");
  assert.equal(permissionExample("research", "claude-code").outcomes.discuss, "方案你点头了再改");
  assert.equal(permissionExample("general", "claude-code").outcomes.discuss, "方案你点头了再建");
  assert.equal(permissionExample("coding", "codex").outcomes.discuss, "不跑，告诉你怎么跑");
  assert.equal(permissionExample("general", null).outcomes.discuss, "不建，告诉你怎么做");
  assert.equal(permissionExample("general", "claude-code").outcomes.auto, "直接建；删文件这类才问");
});

test("⇧Tab 轮换：按顺序走、跳过没有的档、到头回到第一档", () => {
  const all = () => true;
  assert.equal(nextPermissionTier("discuss", all), "ask");
  assert.equal(nextPermissionTier("full", all), "discuss");
  assert.equal(nextPermissionTier(null, all), "discuss");
  // Cursor 那种没有只讨论 / 帮我批准的
  const noDiscussAuto = (id: string) => id === "ask" || id === "full";
  assert.equal(nextPermissionTier("ask", noDiscussAuto), "full");
  assert.equal(nextPermissionTier("full", noDiscussAuto), "ask");
  assert.equal(nextPermissionTier("ask", (id) => id === "ask"), null, "只有当前一档可用：不动");
});

test("按连接记住完全访问：选了记下，换回别的档忘掉，回到本机设置不动", () => {
  // Node 测试无 localStorage：内存桩（kickoff-launch.test 同款）
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
  assert.equal(rememberedFullAccess("p1"), false);
  rememberChatPermission("p1", "write_tree", "full");
  rememberChatPermission("p2", "write_tree", "full");
  assert.equal(rememberedFullAccess("p1"), true);
  rememberChatPermission("p1", "write_tree", null);
  assert.equal(rememberedFullAccess("p1"), true, "换家时自动回落到本机设置不算人改");
  rememberChatPermission("p1", "write_tree", "auto");
  assert.equal(rememberedFullAccess("p1"), false);
  assert.equal(rememberedFullAccess("p2"), true, "别的连接不受影响");
  rememberChatPermission("p2", "discuss", null);
  assert.equal(rememberedFullAccess("p2"), false);
  assert.equal(rememberedFullAccess(""), false);
  store.set("ccode.chatFullAccess", "{oops");
  assert.equal(rememberedFullAccess("p1"), false, "坏值当没记过");
});

test("连接定了 / 换了之后的权限档：记过的带上完全访问，没记过的不接着用上一条的", () => {
  const base = { permission: "write_tree" as const, fullAvailable: true };
  assert.equal(profilePermissionMode({ ...base, mode: null, remembered: true }), "full");
  assert.equal(profilePermissionMode({ ...base, mode: "ask", remembered: true }), undefined, "人选过别的档不动");
  assert.equal(profilePermissionMode({ ...base, mode: "full", remembered: false }), null);
  assert.equal(profilePermissionMode({ ...base, mode: "auto", remembered: false }), undefined);
  assert.equal(profilePermissionMode({ ...base, mode: null, remembered: true, fullAvailable: false }), undefined);
  assert.equal(
    profilePermissionMode({ ...base, mode: "full", remembered: true, fullAvailable: false }),
    undefined,
    "Agent 档表没读到时不忘掉",
  );
  assert.equal(profilePermissionMode({ permission: "discuss", mode: null, remembered: true, fullAvailable: true }), undefined);
});

test("只有聊天对话按连接记权限：新对话、项目新对话、接着聊；步骤、阅读、商量不算", () => {
  assert.equal(chatPermissionMemoryApplies(null), true);
  assert.equal(chatPermissionMemoryApplies("quickchat:abc"), true);
  assert.equal(chatPermissionMemoryApplies("research:/p/proj:project:abc"), true);
  assert.equal(chatPermissionMemoryApplies("resume:codex:s1"), true);
  assert.equal(chatPermissionMemoryApplies("ws:/w/1"), false);
  assert.equal(chatPermissionMemoryApplies("reader:/p\n/p/a.pdf"), false);
  assert.equal(chatPermissionMemoryApplies("discuss:/p:notes/a.md"), false);
});
