import assert from "node:assert/strict";
import test from "node:test";
import {
  groupInbox,
  helpNotifyKeys,
  helpPreview,
  helpSignature,
  inboxCategoryOf,
  inboxCategoryLabel,
  inboxTaskLabel,
  inboxTaskLine,
  isHelpDismissed,
  parseHelpDismissed,
} from "../src/inbox.ts";

test("inboxCategoryOf：key 前缀推导类别，confirm: 与 live: 合并为待确认", () => {
  assert.equal(inboxCategoryOf("conflict:ws-1"), "conflict");
  assert.equal(inboxCategoryOf("confirm:tab-1"), "confirm");
  assert.equal(inboxCategoryOf("live:claude:s-1"), "confirm");
  assert.equal(inboxCategoryOf("ready:ws-2"), "ready");
  assert.equal(inboxCategoryOf("artifacts:ws-3"), "artifacts");
  assert.equal(inboxCategoryOf("digest"), "digest");
  assert.equal(inboxCategoryOf("skill:lit-search"), "skill");
  assert.equal(inboxCategoryOf("profile:p-1"), "profile");
  assert.equal(inboxCategoryOf("help:/repo/root"), "help");
  assert.equal(inboxCategoryOf("lit:s-1:2026-08-18"), "lit");
  assert.equal(inboxCategoryOf("dep:git"), "dep");
  assert.equal(inboxCategoryOf("update:0.1.1"), "update");
  assert.equal(inboxCategoryOf("phone:pending"), "phone");
  assert.equal(inboxCategoryLabel("phone"), "手机");
});

test("inboxTaskLine：名字紧贴状态，和项目现在同一句式", () => {
  assert.equal(inboxTaskLine("文献精读", "待确认"), "文献精读待确认");
  assert.equal(inboxTaskLine("  ", "有冲突"), "这项工作有冲突");
  assert.equal(inboxTaskLine("示例课题", "有3条新命中待评审"), "示例课题有3条新命中待评审");
  assert.equal(inboxTaskLine("对话", "待发送"), "对话待发送");
});

test("inboxTaskLabel：工作区名优先，占位标题回落目录", () => {
  assert.equal(
    inboxTaskLabel({ workspaceName: "lit-notes", title: "终端", cwdLabel: "notes" }),
    "lit-notes",
  );
  assert.equal(
    inboxTaskLabel({ title: "终端", cwdLabel: "feature-login" }),
    "feature-login",
  );
  assert.equal(
    inboxTaskLabel({ title: "feature/login", cwdLabel: "login" }),
    "feature/login",
  );
});

test("inboxCategoryOf：未知前缀回落待确认（不静默丢失）", () => {
  assert.equal(inboxCategoryOf("whatever"), "confirm");
});

test("inboxCategoryLabel：类别中文标签齐备（更新在依赖之后、文献之前）", () => {
  assert.deepEqual(
    [
      "conflict",
      "confirm",
      "dep",
      "update",
      "lit",
      "ready",
      "artifacts",
      "digest",
      "profile",
      "help",
    ].map((c) => inboxCategoryLabel(c as Parameters<typeof inboxCategoryLabel>[0])),
    [
      "冲突",
      "待确认",
      "依赖",
      "更新",
      "文献",
      "可合并",
      "待核验",
      "待发送",
      "配置失效",
      "人工请求",
    ],
  );
});

test("groupInbox：固定顺序、空类不返回、类内保持原顺序", () => {
  const items = [
    { key: "ready:ws-2" },
    { key: "conflict:ws-1" },
    { key: "confirm:tab-1" },
    { key: "help:/r1" },
    { key: "lit:s-1:t1" },
    { key: "live:claude:s-1" },
    { key: "update:0.1.1" },
    { key: "ready:ws-3" },
  ];
  const groups = groupInbox(items);
  assert.deepEqual(
    groups.map((g) => [g.category, g.label, g.items.map((it) => it.key)]),
    [
      ["conflict", "冲突", ["conflict:ws-1"]],
      ["confirm", "待确认", ["confirm:tab-1", "live:claude:s-1"]],
      ["update", "更新", ["update:0.1.1"]],
      ["lit", "文献", ["lit:s-1:t1"]],
      ["ready", "可合并", ["ready:ws-2", "ready:ws-3"]],
      ["help", "人工请求", ["help:/r1"]],
    ],
  );
});

test("groupInbox：全空返回空数组", () => {
  assert.deepEqual(groupInbox([]), []);
});

test("helpSignature：join 口径稳定，内容变化签名即变", () => {
  assert.equal(helpSignature(["甲", "乙"]), "甲|乙");
  assert.notEqual(helpSignature(["甲", "乙"]), helpSignature(["甲", "乙丙"]));
  assert.equal(helpSignature([]), "");
});

test("isHelpDismissed：签名一致才算屏蔽；内容变了自动复现", () => {
  const dismissed = { "/repo": "甲|乙" };
  assert.equal(isHelpDismissed(dismissed, "/repo", "甲|乙"), true);
  assert.equal(isHelpDismissed(dismissed, "/repo", "甲|乙|丙"), false);
  assert.equal(isHelpDismissed(dismissed, "/other", "甲|乙"), false);
});

test("parseHelpDismissed：坏 JSON / 非对象 / 非字符串值容错为空表", () => {
  assert.deepEqual(parseHelpDismissed(null), {});
  assert.deepEqual(parseHelpDismissed(""), {});
  assert.deepEqual(parseHelpDismissed("not json"), {});
  assert.deepEqual(parseHelpDismissed('["/a"]'), {});
  assert.deepEqual(parseHelpDismissed('{"a":"sig","b":1,"c":null}'), {
    a: "sig",
  });
});

test("helpPreview：40 字截断，超出加省略号", () => {
  assert.equal(helpPreview("短句"), "短句");
  const exact = "字".repeat(40);
  assert.equal(helpPreview(exact), exact);
  assert.equal(helpPreview(`${exact}多`), `${exact}…`);
});

test("helpNotifyKeys：首轮基线不通知（prev null）", () => {
  assert.deepEqual(helpNotifyKeys(null, ["help:/a"], new Map(), 1000), []);
});

test("helpNotifyKeys：新 root edge-trigger，已存在的不重复通知", () => {
  const prev = new Set(["help:/a"]);
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a", "help:/b"], new Map(), 1000),
    ["help:/b"],
  );
});

test("helpNotifyKeys：同一 root 30 秒去抖，窗口外放行", () => {
  const prev = new Set<string>();
  const lastSentAt = new Map([["help:/a", 10_000]]);
  // 10s 后再出现：去抖抑制
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a"], lastSentAt, 20_000),
    [],
  );
  // 恰好满 30s：放行
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/a"], lastSentAt, 40_000),
    ["help:/a"],
  );
  // 从未通知过的 root：立即放行
  assert.deepEqual(
    helpNotifyKeys(prev, ["help:/b"], lastSentAt, 20_000),
    ["help:/b"],
  );
});

// ── 通用忽略（v3.88）：原先只有 help: 能忽略 ──
import {
  filterDismissed,
  inboxSignature,
} from "../src/inbox.ts";

test("忽略后条目消失，内容变化即复现", () => {
  const item = { key: "ready:w1", text: "任务 A 可合并", actionLabel: "去评审" };
  const dismissed = { [item.key]: inboxSignature(item) };
  assert.deepEqual(filterDismissed([item], dismissed), []);
  // 同一 key 但状态变了（文案变）→ 签名不同 → 重新出现
  const changed = { ...item, text: "任务 A 有冲突" };
  assert.deepEqual(filterDismissed([changed], dismissed), [changed]);
});

test("未忽略的条目原样保留", () => {
  const a = { key: "conflict:x", text: "冲突", actionLabel: "解决" };
  assert.deepEqual(filterDismissed([a], {}), [a]);
});
