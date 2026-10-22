import assert from "node:assert/strict";
import test from "node:test";
import {
  askAiCanSkip,
  askAiDirectLaunch,
  askAiProjectName,
  buildAskAiPending,
  type AskAiRemembered,
} from "../src/ask-ai.ts";

const file = {
  path: "/p/papers/a.pdf",
  name: "a.pdf",
  cwd: "/p",
  root: "/p",
  reuseKey: "lit:/p:papers/a.pdf",
};

test("问 AI 记住且勾了默认、配置还在才跳过选择", () => {
  const r: AskAiRemembered = {
    agentId: "codex",
    profileId: "p1",
    model: "gpt-5.1",
    useDefault: true,
  };
  assert.equal(askAiCanSkip(r, [{ id: "p1" }]), true);
  assert.equal(askAiCanSkip(r, [{ id: "other" }]), false);
  assert.equal(askAiCanSkip({ ...r, useDefault: false }, [{ id: "p1" }]), false);
  assert.equal(askAiCanSkip(null, [{ id: "p1" }]), false);
});

test("问 AI 交接：带上选择、不进聊天层、打开预览", () => {
  const pt = buildAskAiPending(file, {
    agentId: "codex",
    profileId: "official-1",
    model: "",
  });
  assert.equal(pt.agentId, "codex");
  assert.equal(pt.profileId, "official-1");
  assert.equal(pt.model, "");
  assert.equal(pt.autoStart, true);
  assert.equal(pt.surface, undefined);
  assert.equal(pt.previewPath, "/p/papers/a.pdf");
  assert.equal(pt.previewRoot, "/p");
  assert.match(pt.initialPrompt ?? "", /请看这份文件/);
});

test("问 AI 可覆盖 prompt，项目级新对话不预览、不预填", () => {
  const custom = buildAskAiPending(
    { ...file, prompt: "请分析这份表格" },
    { agentId: "codex", profileId: "p1", model: "" },
  );
  assert.equal(custom.initialPrompt, "请分析这份表格");
  assert.equal(custom.previewPath, "/p/papers/a.pdf");
  const fresh = buildAskAiPending(
    {
      path: "",
      name: "AI模型",
      cwd: "/p",
      root: "/p",
      reuseKey: "office:/p:project",
      prompt: "",
      preview: false,
    },
    { agentId: "codex", profileId: "p1", model: "" },
  );
  assert.equal(fresh.initialPrompt, undefined);
  assert.equal(fresh.previewPath, undefined);
  assert.equal(fresh.previewRoot, undefined);
  assert.equal(fresh.title, "AI模型");
});

test("项目绑了 Agents 就直接启动，不走问 AI 记忆", () => {
  const remembered: AskAiRemembered = {
    agentId: "claude-code",
    profileId: "p-claude",
    model: "sonnet",
    useDefault: true,
  };
  const profiles = [
    { id: "p-claude", agent: "claude-code", models: ["sonnet"] },
    { id: "p-codex", agent: "codex", models: ["gpt-5"] },
  ];
  const project = askAiDirectLaunch(
    { preferredAgent: "codex", preferredProfile: "p-codex" },
    profiles,
    remembered,
  );
  assert.deepEqual(project, { agentId: "codex", profileId: "p-codex", model: "gpt-5" });
  assert.deepEqual(
    askAiDirectLaunch(
      { preferredAgent: "codex", preferredProfile: "p-codex", preferredModel: "gpt-5-mini" },
      [{ id: "p-codex", agent: "codex", models: ["gpt-5", "gpt-5-mini"] }],
      remembered,
    ),
    { agentId: "codex", profileId: "p-codex", model: "gpt-5-mini" },
  );
  assert.equal(
    askAiDirectLaunch(
      { preferredAgent: "codex", preferredProfile: "p-codex" },
      profiles,
      remembered,
      true,
    ),
    null,
  );
  const noRoster = askAiDirectLaunch({}, profiles, remembered);
  assert.deepEqual(noRoster, {
    agentId: "claude-code",
    profileId: "p-claude",
    model: "sonnet",
  });
  assert.equal(askAiDirectLaunch({}, profiles, null), null);
});

test("askAiProjectName：对着文件问时用项目注册名，不用文件名", () => {
  const projects = [{ path: "/u/Desktop/测试项目", name: "测试项目" }];
  const shot = {
    path: "/u/Desktop/测试项目/notes/assets/phone-20261021-092949.jpg",
    name: "phone-20261021-092949.jpg",
    root: "/u/Desktop/测试项目",
    cwd: "/u/Desktop/测试项目",
  };
  assert.equal(askAiProjectName(shot, projects, false), "测试项目");
  // 未注册目录：根目录末段
  assert.equal(askAiProjectName({ ...shot, root: "/u/repo/" }, projects, false), "repo");
  // 项目级新对话（无文件）：name 本来就是项目名
  assert.equal(
    askAiProjectName({ path: "", name: "我的课题", root: "/x", cwd: "/x" }, [], false),
    "我的课题",
  );
  // Windows 路径大小写不敏感
  assert.equal(
    askAiProjectName(
      { path: "C:\\P\\a.pdf", name: "a.pdf", root: "c:/p", cwd: "c:/p" },
      [{ path: "C:\\P", name: "课题P" }],
      true,
    ),
    "课题P",
  );
});
