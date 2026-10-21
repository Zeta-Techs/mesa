import assert from "node:assert/strict";
import test from "node:test";
import {
  IDLE_PHONE_STATUS,
  formatPhoneSize,
  phoneDeviceLine,
  phoneInboxFields,
  phoneItemActions,
  phoneItemOpenable,
  phoneItemStatusText,
  phonePairedCard,
  phonePlacedLabel,
  phonePendingCount,
  phoneStateLine,
  phoneStopNote,
  pickPlaceProject,
} from "../src/phone-drop.ts";

test("phoneItemActions：对话模式能附到输入框，已附的不再给", () => {
  const ctx = { canAttach: true, canPlace: true };
  assert.deepEqual(phoneItemActions({ kind: "image", status: "new" }, ctx), [
    "attach",
    "place",
    "saveAs",
    "delete",
  ]);
  assert.deepEqual(phoneItemActions({ kind: "image", status: "attached" }, ctx), [
    "place",
    "saveAs",
    "delete",
  ]);
  assert.deepEqual(phoneItemActions({ kind: "text", status: "new" }, ctx), [
    "attach",
    "place",
    "copy",
    "delete",
  ]);
});

test("phoneItemActions：其他文件不放进项目；没有可放的项目不给放；放过的不再给", () => {
  assert.deepEqual(phoneItemActions({ kind: "file", status: "new" }, { canAttach: false, canPlace: true }), [
    "saveAs",
    "delete",
  ]);
  assert.deepEqual(phoneItemActions({ kind: "pdf", status: "new" }, { canAttach: false, canPlace: false }), [
    "saveAs",
    "delete",
  ]);
  assert.deepEqual(phoneItemActions({ kind: "pdf", status: "placed" }, { canAttach: false, canPlace: true }), [
    "saveAs",
    "delete",
  ]);
});

test("pickPlaceProject：对话目录所在的科研 / 办公项目优先，编程项目不放，否则取最近打开的", () => {
  const projects = [
    { path: "/u/code-repo", workMode: "coding" },
    { path: "/u/thesis", workMode: "research" },
    { path: "/u/thesis/sub", workMode: "office" },
    { path: "/u/other" },
  ];
  assert.equal(pickPlaceProject(projects, "/u/thesis/sub/data", false), "/u/thesis/sub");
  assert.equal(pickPlaceProject(projects, "/u/thesis/notes", false), "/u/thesis");
  assert.equal(pickPlaceProject(projects, "/u/code-repo/src", false), "/u/thesis", "编程项目里不放，回落最近打开的");
  assert.equal(pickPlaceProject(projects, null, false), "/u/thesis");
  assert.equal(pickPlaceProject([{ path: "/u/c", workMode: "coding" }], null, false), null);
  assert.equal(
    pickPlaceProject([{ path: "C:\\Users\\a\\thesis" }], "c:/users/a/thesis/x", true),
    "C:\\Users\\a\\thesis",
  );
});

test("收件箱：只数还没处理的；条数进签名", () => {
  const items = [{ status: "new" }, { status: "attached" }, { status: "new" }, { status: "placed" }] as const;
  assert.equal(phonePendingCount(items), 2);
  assert.equal(phoneInboxFields(0), null);
  assert.deepEqual(phoneInboxFields(2), { key: "phone:pending", text: "手机发来 2 条还没处理" });
});

test("状态文案", () => {
  assert.equal(phoneStateLine(IDLE_PHONE_STATUS, null), "没有在接收");
  const on = { ...IDLE_PHONE_STATUS, receiving: true };
  assert.equal(phoneStateLine(on, null), "等手机扫码…");
  assert.equal(phoneStateLine({ ...on, connected: true }, null), "手机已连上");
  assert.equal(phoneStateLine({ ...on, connected: true, received: 3 }, null), "手机已连上 · 已收 3 条");
  assert.equal(phoneStateLine({ ...on, connected: true }, "IMG_1.jpg"), "正在接收 IMG_1.jpg…");
  assert.equal(phoneItemStatusText({ status: "placed", placedTo: "papers/a.pdf" }), "已放进 papers/a.pdf");
  assert.equal(
    phoneItemStatusText({ status: "placed", placedTo: "notes/assets/phone-20261021-092945.jpg" }),
    "已放进 notes/assets/",
  );
  assert.equal(phonePlacedLabel("notes/clips.md"), "notes/clips.md");
  assert.equal(phonePlacedLabel("papers/A Review of Advanced Energy Materials.pdf"), "papers/");
  assert.equal(phoneItemOpenable({ kind: "image", path: "/x/a.jpg" }), true);
  assert.equal(phoneItemOpenable({ kind: "file", path: "/x/a.xlsx" }), true);
  assert.equal(phoneItemOpenable({ kind: "text", path: null }), true);
  assert.equal(phoneItemOpenable({ kind: "image", path: null }), false);
  assert.equal(phoneItemStatusText({ status: "new", placedTo: null }), "");
  assert.match(phoneStopNote("idle") ?? "", /30 分钟/);
  assert.equal(phoneStopNote("stopped"), null);
  assert.match(phoneStopNote("network-rescan") ?? "", /重新扫码/);
  assert.equal(phoneStopNote("network"), null);
  assert.equal(formatPhoneSize(512), "512 B");
  assert.equal(formatPhoneSize(300 * 1024), "300 KB");
  assert.equal(formatPhoneSize(4.25 * 1024 * 1024), "4.3 MB");
});

test("已配对手机：状态行写是哪台手机，设备行写上次用的时间", () => {
  const on = { ...IDLE_PHONE_STATUS, receiving: true };
  assert.equal(phoneStateLine(on, null, true), "等手机打开「发到 Mesa」…");
  assert.equal(phoneStateLine({ ...on, connected: true, lastDevice: "iPhone" }, null, true), "iPhone 已连上");
  assert.equal(
    phoneStateLine({ ...on, connected: true, lastDevice: "iPhone", received: 2 }, null, true),
    "iPhone 已连上 · 已收 2 条",
  );
  const now = new Date(2026, 9, 21, 15, 0);
  assert.equal(
    phoneDeviceLine({ pairedAt: "x", lastSeenAt: new Date(2026, 9, 21, 9, 5).toISOString() }, now),
    "上次用 今天 09:05",
  );
  assert.equal(
    phoneDeviceLine({ pairedAt: "x", lastSeenAt: new Date(2026, 9, 19, 9, 5).toISOString() }, now),
    "上次用 10月19日",
  );
  assert.equal(phoneDeviceLine({ pairedAt: new Date(2026, 9, 20).toISOString(), lastSeenAt: null }, now), "10月20日 配对");
  assert.equal(phoneDeviceLine({ pairedAt: "bad", lastSeenAt: null }, now), "");
});

test("已配对状态卡：主动接收、常驻等候、都没开三种说法", () => {
  const base = { ...IDLE_PHONE_STATUS };
  assert.equal(phonePairedCard({ ...base, receiving: true }, null).title, "等手机打开「发到 Mesa」…");
  const standby = { ...base, standby: true };
  assert.equal(phonePairedCard(standby, null).title, "手机随时能发");
  assert.match(phonePairedCard(standby, null).hint, /不用先在这里点开始/);
  assert.equal(phonePairedCard({ ...standby, connected: true, lastDevice: "iPhone" }, null).title, "iPhone 已连上");
  assert.equal(phonePairedCard(standby, "a.jpg").title, "正在接收 a.jpg…");
  const off = phonePairedCard(base, null);
  assert.equal(off.title, "没在接收");
  assert.equal(off.live, false);
});
