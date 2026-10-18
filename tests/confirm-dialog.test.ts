import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmKeyAction,
  factTone,
  inferConfirmText,
  parseConfirmMessage,
} from "../src/confirm-dialog.ts";

test("确认框：Esc 一律取消", () => {
  assert.equal(
    confirmKeyAction({
      key: "Escape",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "cancel",
  );
  assert.equal(
    confirmKeyAction({
      key: "Escape",
      alert: true,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "cancel",
  );
});

test("确认框：Enter 在取消钮上取消，否则确认", () => {
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: true,
      enterBlocked: false,
    }),
    "cancel",
  );
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "confirm",
  );
});

test("确认框：单按钮提示 Enter 确认；组词中的 Enter 忽略", () => {
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: true,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "confirm",
  );
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: true,
    }),
    "none",
  );
});

test("正文结构化：首段短句当标题、成组键值行当对照表、注意段当注意条", () => {
  const c = parseConfirmMessage(
    "清除「Blender」的 Mesa 痕迹？\n\n" +
      "文件夹与你的文件：保留\n" +
      ".ccode/（档案卡、任务卡、各步骤 TASK.md 内容）：移入回收站（可找回）\n" +
      "工作区 worktree 与分支、注册记录：彻底删除\n\n" +
      "注意：如果 .ccode 曾被 git 跟踪，需要你自行提交。",
  );
  assert.equal(c.title, "清除「Blender」的 Mesa 痕迹？");
  assert.equal(c.blocks.length, 2);
  const facts = c.blocks[0];
  assert.equal(facts.kind, "facts");
  if (facts.kind === "facts") {
    assert.deepEqual(
      facts.rows.map((r) => [r.key, r.tone]),
      [
        ["文件夹与你的文件", "safe"],
        [".ccode/（档案卡、任务卡、各步骤 TASK.md 内容）", "neutral"],
        ["工作区 worktree 与分支、注册记录", "danger"],
      ],
    );
  }
  assert.deepEqual(c.blocks[1], {
    kind: "note",
    text: "如果 .ccode 曾被 git 跟踪，需要你自行提交。",
  });
});

test("正文结构化：单行键值不成表、半角冒号不认、长首段不当标题", () => {
  // 单独一行「x：y」更像一句话，不拆表
  assert.deepEqual(parseConfirmMessage("标题？\n\n复制失败：网络错误").blocks, [
    { kind: "text", text: "复制失败：网络错误" },
  ]);
  // 半角冒号（路径、URL）不当键值
  const p = parseConfirmMessage("删除？\n\nC:\\Users\\a\nhttps://x.org/a");
  assert.equal(p.blocks[0].kind, "text");
  // 首段过长 / 多行 → 无标题，全部进正文
  const long = "很".repeat(61);
  assert.equal(parseConfirmMessage(long).title, null);
  assert.equal(parseConfirmMessage("第一行\n第二行").title, null);
});

test("后果语气：保留为安全、彻底/不可恢复为危险", () => {
  assert.equal(factTone("保留"), "safe");
  assert.equal(factTone("彻底删除"), "danger");
  assert.equal(factTone("删除后不可恢复"), "danger");
  assert.equal(factTone("移入回收站（可找回）"), "neutral");
});

test("危险按钮文字取标题里最早的动词；显式文字优先；非危险不推断", () => {
  assert.equal(inferConfirmText("清除「x」的 Mesa 痕迹？", true, undefined), "清除");
  assert.equal(
    inferConfirmText("只移除「x」的项目注册，不删除磁盘目录。继续？", true, undefined),
    "移除",
  );
  assert.equal(inferConfirmText("删除项目「x」？", true, "仍要删除"), "仍要删除");
  assert.equal(inferConfirmText("删除项目「x」？", false, undefined), "确认");
  assert.equal(inferConfirmText("继续？", true, undefined), "确认");
  assert.equal(inferConfirmText(null, true, undefined), "确认");
});
