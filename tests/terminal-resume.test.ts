import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findResumeHolderTab,
  fittedPtySize,
  lastWriteIsMesas,
  launchPtySize,
  resolveResumeLaunch,
  resumeModelChoice,
  resumeProfileChoice,
  shouldRelaunchResumeTab,
} from "../src/terminal-resume.ts";

const tab = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ...extra,
});
const st = (
  alive: boolean,
  extra: Partial<{
    runId: string | null;
    sessionId: string | null;
    agentId: string;
  }> = {},
) => ({
  alive,
  runId: null,
  sessionId: null,
  agentId: "",
  ...extra,
});

test("resume 兜底：只按 runId 或 agent+sessionId 认身份", () => {
  const tabs = [
    tab("t-claude", { initialAgentId: "claude-code" }),
    tab("t-codex", { initialAgentId: "codex" }),
    tab("t-shell"),
  ];
  const statuses = {
    // 同目录的别家 agent 标签：不是这条会话的持有者
    "t-claude": st(true, { agentId: "claude-code", sessionId: "s-other" }),
    "t-codex": st(true, { agentId: "codex", sessionId: "s-target" }),
    // shell 标签没有会话身份
    "t-shell": st(true),
  };
  const hit = findResumeHolderTab(tabs, statuses, {
    agentId: "codex",
    sessionId: "s-target",
  });
  assert.equal(hit?.id, "t-codex");
});

test("resume 兜底：同会话但 agent 不同不命中（防串 agent）", () => {
  const tabs = [tab("t1", { initialAgentId: "claude-code" })];
  const statuses = {
    t1: st(true, { agentId: "claude-code", sessionId: "s-target" }),
  };
  const hit = findResumeHolderTab(tabs, statuses, {
    agentId: "codex",
    sessionId: "s-target",
  });
  assert.equal(hit, undefined);
});

test("resume 兜底：runId 命中优先（会话尚未联动也认得）", () => {
  const tabs = [tab("t1", { runId: "run-1" }), tab("t2", { runId: "run-2" })];
  const statuses = {
    t1: st(true, { runId: "run-1" }),
    t2: st(true, { runId: "run-2" }),
  };
  const hit = findResumeHolderTab(tabs, statuses, {
    runId: "run-2",
    agentId: "codex",
    sessionId: "s-x",
  });
  assert.equal(hit?.id, "t2");
});

test("resume 兜底：不活的标签不命中", () => {
  const tabs = [tab("t1")];
  const statuses = {
    t1: st(false, { agentId: "codex", sessionId: "s-target" }),
  };
  assert.equal(
    findResumeHolderTab(tabs, statuses, {
      agentId: "codex",
      sessionId: "s-target",
    }),
    undefined,
  );
  // 还没有状态上报（刚挂载）也不命中
  assert.equal(
    findResumeHolderTab(tabs, {}, { agentId: "codex", sessionId: "s-target" }),
    undefined,
  );
});

test("已有 resume 标签但没在跑：再点继续应重试启动", () => {
  assert.equal(shouldRelaunchResumeTab(undefined), true);
  assert.equal(shouldRelaunchResumeTab(st(false)), true);
  assert.equal(
    shouldRelaunchResumeTab({ alive: true, running: true }),
    false,
    "Agent 还在跑只切过去",
  );
  assert.equal(
    shouldRelaunchResumeTab({ alive: true, running: false }),
    true,
    "回落 shell 也要再拉起，不能只盯着空壳",
  );
  assert.equal(shouldRelaunchResumeTab({ alive: false, running: true }), false);
});

test("启动格子：量到的行列原样带上，没量到或非法则不传", () => {
  assert.deepEqual(launchPtySize({ cols: 140, rows: 42 }), { cols: 140, rows: 42 });
  assert.equal(launchPtySize(null), null);
  assert.equal(launchPtySize({ cols: 1, rows: 24 }), null);
  assert.equal(launchPtySize({ cols: 80, rows: 0 }), null);
  assert.equal(launchPtySize({ cols: 80.5, rows: 24 }), null);
  let fitted = 0;
  assert.deepEqual(
    fittedPtySize(
      { fit: () => { fitted += 1; } },
      { cols: 120, rows: 36 },
    ),
    { cols: 120, rows: 36 },
  );
  assert.equal(fitted, 1);
  assert.equal(
    fittedPtySize({ fit: () => { throw new Error("zero"); } }, { cols: 120, rows: 36 }),
    null,
  );
});

const apiProfile = (id: string, agent = "codex") => ({
  id,
  agent,
  baseUrl: "https://relay.example.com/v1",
  accountType: "api" as const,
  models: [`m-${id}`],
});

test("恢复带原配置：有效则优先原配置，不被「上次使用」覆盖", () => {
  const profiles = [apiProfile("p-run"), apiProfile("p-last")];
  const pick = resolveResumeLaunch(
    profiles,
    { agentId: "codex", profileId: "p-run", provider: "ccode" },
    [],
    "p-last",
  );
  assert.deepEqual(pick, {
    profileId: "p-run",
    model: "m-p-run",
    reselectNeeded: false,
  });
});

test("恢复带原配置：保留调用方传入的模型", () => {
  const profiles = [apiProfile("p-run")];
  const pick = resolveResumeLaunch(profiles, {
    agentId: "codex",
    profileId: "p-run",
    model: "explicit-model",
  });
  assert.equal(pick.model, "explicit-model");
  assert.equal(pick.reselectNeeded, false);
});

test("恢复带原配置：已删除/停用/串 agent 都要求重选，不静默替换", () => {
  const profiles = [apiProfile("p-run"), apiProfile("p-other")];
  for (const [req, hidden] of [
    [{ agentId: "codex", profileId: "p-deleted" }, []],
    [{ agentId: "codex", profileId: "p-run" }, ["p-run"]],
    [{ agentId: "claude-code", profileId: "p-run" }, []],
  ] as const) {
    const pick = resolveResumeLaunch(profiles, req, hidden);
    assert.equal(pick.reselectNeeded, true, JSON.stringify(req));
    assert.equal(pick.profileId, "");
  }
});

test("恢复未带原配置：沿用 pickResumeProfile 挑选（wished 优先）", () => {
  const profiles = [apiProfile("p-a"), apiProfile("p-b")];
  const pick = resolveResumeLaunch(
    profiles,
    { agentId: "codex", provider: "ccode", autoLaunchProfileId: "p-b" },
    [],
    "p-a",
  );
  assert.equal(pick.profileId, "p-b");
  assert.equal(pick.reselectNeeded, false);
  assert.equal(pick.channelChanged, false);
});

const officialProfile = (id: string) => ({
  id,
  agent: "codex",
  baseUrl: null,
  accountType: "official" as const,
  models: ["gpt-5"],
});

test("项目默认官方账号：启动栏用官方，不因网关会话而显示上次的网关", () => {
  const profiles = [officialProfile("p-official"), apiProfile("p-gw")];
  const pick = resolveResumeLaunch(
    profiles,
    {
      agentId: "codex",
      provider: "ccode",
      autoLaunchProfileId: "p-official",
    },
    [],
    "p-gw",
  );
  assert.equal(pick.profileId, "p-official");
  assert.equal(pick.model, "gpt-5");
  assert.equal(pick.reselectNeeded, false);
  assert.equal(pick.channelChanged, true);
});

test("项目默认与会话渠道一致时仍自动启动", () => {
  const profiles = [officialProfile("p-official"), apiProfile("p-gw")];
  const pick = resolveResumeLaunch(profiles, {
    agentId: "codex",
    provider: "openai",
    autoLaunchProfileId: "p-official",
  });
  assert.equal(pick.profileId, "p-official");
  assert.equal(pick.channelChanged, false);
});

test("接着聊用这段对话自己的连接：还在就用它，项目默认不再盖过；不在了才按项目默认", () => {
  const profiles = [
    { id: "glm", agent: "claude-code" },
    { id: "proj", agent: "claude-code" },
    { id: "cx", agent: "codex" },
  ];
  const base = { agentId: "claude-code", profiles };
  assert.deepEqual(resumeProfileChoice({ ...base, own: "glm", preferred: "proj" }), { profileId: "glm" });
  // 自己那条删了 / 停用了：按项目默认（交给 resolveResumeLaunch 的 autoLaunchProfileId）
  assert.deepEqual(resumeProfileChoice({ ...base, own: "gone", preferred: "proj" }), {
    autoLaunchProfileId: "proj",
  });
  assert.deepEqual(resumeProfileChoice({ ...base, own: "glm", preferred: "proj", hidden: ["glm"] }), {
    autoLaunchProfileId: "proj",
  });
  // 别家的连接不算
  assert.deepEqual(resumeProfileChoice({ ...base, own: "cx", preferred: null }), { profileId: "cx" });
  // 都没有：交给「上次使用」
  assert.deepEqual(resumeProfileChoice({ ...base, own: null, preferred: null }), {});
  // 自己那条不在、项目也没设：照旧带上，由「原配置已失效」提示重选
  assert.deepEqual(resumeProfileChoice({ ...base, own: "gone", preferred: "" }), { profileId: "gone" });
});

test("接着聊默认的模型：换到的连接名单里有它（或名单空着）才带上", () => {
  assert.equal(resumeModelChoice("glm-5.3", { models: ["glm-4.7", "glm-5.3"] }), "glm-5.3");
  assert.equal(resumeModelChoice("glm-5.3", { models: [] }), "glm-5.3");
  assert.equal(resumeModelChoice("glm-5.3", { models: ["deepseek-v4"] }), undefined);
  assert.equal(resumeModelChoice(null, { models: ["glm-5.3"] }), undefined);
  assert.equal(resumeModelChoice("glm-5.3", undefined), undefined);
});

test("最近一分钟的写入是 Mesa 自己刚停掉的进程写的：不算别的终端在跑（2026-10-24 误报实证）", () => {
  // 关掉标签 03:54:48，最后一笔 03:54:45
  const run = { closedAt: "2026-10-24T03:54:48.020+08:00" };
  assert.equal(lastWriteIsMesas("2026-10-23T19:54:45.282Z", run), true);
  // 停下之后几秒内的最后一笔（CLI 退出前收尾）也算
  assert.equal(lastWriteIsMesas("2026-10-23T19:54:52Z", run), true);
  // 停下之后很久又写了：是别处在写
  assert.equal(lastWriteIsMesas("2026-10-23T19:55:30Z", run), false);
  // 没停过 / 没有 Run 记录 / 时间读不出：不知道，照旧提醒
  assert.equal(lastWriteIsMesas("2026-10-23T19:54:45Z", { closedAt: null }), false);
  assert.equal(lastWriteIsMesas("2026-10-23T19:54:45Z", null), false);
  assert.equal(lastWriteIsMesas(null, run), false);
});
