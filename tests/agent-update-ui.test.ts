import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCardHeadline,
  agentHeaderUpdateState,
  agentNavUpdateState,
  isAlreadyLatestResult,
} from "../src/agent-update-ui.ts";

test("左栏状态流转：新版 → 更新中 → 已更新（及已最新 / 失败）", () => {
  // 有新版待升级
  assert.deepEqual(
    agentNavUpdateState({
      agentLabel: "Kimi Code",
      installed: true,
      updating: false,
      outdated: true,
      latest: "2.5.2",
    }),
    { kind: "outdated", latest: "2.5.2", title: "有新版本 2.5.2，点击更新" },
  );

  // 点击侧栏「新版」后立即进入更新中
  assert.deepEqual(
    agentNavUpdateState({
      agentLabel: "Kimi Code",
      installed: true,
      updating: true,
      cmdKind: "update",
      outdated: true,
      latest: "2.5.2",
    }),
    { kind: "running", action: "update", label: "更新中", title: "正在更新 Kimi Code 到 2.5.2，点击查看进度" },
  );

  // 更新刚跑完、后端 check_agent_updates 重查尚未返回（outdated 仍暂为 true）时，结果态优先，不闪回「新版」
  assert.deepEqual(
    agentNavUpdateState({
      agentLabel: "Kimi Code",
      installed: true,
      updating: false,
      cmdKind: "update",
      outdated: true,
      latest: "2.5.2",
      result: {
        ok: true,
        output: "updated",
        method: "self",
        versionBefore: "2.5.1",
        versionAfter: "2.5.2",
      },
    }),
    {
      kind: "done-ok",
      alreadyLatest: false,
      label: "已更新",
      title: "Kimi Code 已更新（2.5.1 → 2.5.2）",
    },
  );

  // 自更新发现本就是最新版：显示「已最新」
  const sameVer = {
    ok: true,
    output: "You are already on the latest version.",
    method: "self",
    versionBefore: "1.5.8",
    versionAfter: "1.5.8",
  };
  assert.equal(isAlreadyLatestResult(sameVer), true);
  assert.deepEqual(
    agentNavUpdateState({
      agentLabel: "Antigravity CLI",
      installed: true,
      updating: false,
      cmdKind: "update",
      outdated: false,
      result: sameVer,
    }),
    {
      kind: "done-ok",
      alreadyLatest: true,
      label: "已最新",
      title: "Antigravity CLI 已是最新版本（1.5.8）",
    },
  );

  // 更新失败：左栏明确标红「失败」供点击查看
  assert.deepEqual(
    agentNavUpdateState({
      agentLabel: "Kimi Code",
      installed: true,
      updating: false,
      cmdKind: "update",
      outdated: true,
      result: {
        ok: false,
        output: "network timeout",
        method: "self",
        versionBefore: "2.5.1",
        versionAfter: null,
      },
    }),
    { kind: "done-err", action: "update", label: "失败", title: "Kimi Code 更新失败，点击查看输出" },
  );
});

test("组头右上角状态：首次检查中不闪「更新」、已最新隐藏、离线确认后不复现", () => {
  const base = {
    installed: true,
    installedVersion: "1.5.8",
    updating: false,
    tuiPrefill: null,
    upstreamNote: null,
    upstreamCommand: null,
  };

  // 刚进连接页，check_agent_updates 尚未返回 → 不提前闪出「更新」
  assert.deepEqual(
    agentHeaderUpdateState({ ...base, updateCheckReady: false }),
    { kind: "hidden" },
  );

  // 清单查到 1.5.8 已最新 → 右上角隐藏
  assert.deepEqual(
    agentHeaderUpdateState({
      ...base,
      updateCheckReady: true,
      info: { latest: "1.5.8", outdated: false },
    }),
    { kind: "hidden" },
  );

  // 离线查不到 latest 时保留手动「更新」兜底；跑完确认已是最新（8s 提示收起后）不再常驻「更新」
  assert.deepEqual(
    agentHeaderUpdateState({
      ...base,
      updateCheckReady: true,
      info: { latest: null, outdated: false },
    }),
    { kind: "fallback-update", label: "更新", tuiPrefill: null },
  );
  assert.deepEqual(
    agentHeaderUpdateState({
      ...base,
      updateCheckReady: true,
      info: { latest: null, outdated: false },
      confirmedVersion: "1.5.8",
    }),
    { kind: "hidden" },
  );

  // 失败后右上角给「重试」
  assert.deepEqual(
    agentHeaderUpdateState({
      ...base,
      updateCheckReady: true,
      info: { latest: "1.5.9", outdated: true },
      result: {
        ok: false,
        output: "err",
        method: "self",
        versionBefore: "1.5.8",
        versionAfter: null,
      },
    }),
    { kind: "fallback-update", label: "重试", tuiPrefill: null },
  );
});

test("统一进度与结果卡标题区分更新完成、已是最新与安装", () => {
  assert.deepEqual(
    agentCardHeadline({
      agentLabel: "Kimi Code",
      cmdKind: "update",
      installedVersion: "2.5.1",
      targetVersion: "2.5.2",
    }),
    { tone: "running", title: "正在更新 Kimi Code（2.5.1 → 2.5.2）" },
  );
  assert.deepEqual(
    agentCardHeadline({
      agentLabel: "Antigravity CLI",
      cmdKind: "update",
      result: {
        ok: true,
        output: "You are already on the latest version.",
        method: "self",
        versionBefore: "1.5.8",
        versionAfter: "1.5.8",
      },
    }),
    { tone: "ok", title: "已是最新版本（self）：1.5.8" },
  );
  assert.deepEqual(
    agentCardHeadline({
      agentLabel: "Antigravity CLI",
      cmdKind: "install",
      result: {
        ok: true,
        output: "installed",
        method: "script",
        versionBefore: null,
        versionAfter: "1.5.8",
      },
    }),
    { tone: "ok", title: "安装完成（script）：1.5.8" },
  );
});
