import assert from "node:assert/strict";
import test from "node:test";
import { pasteGuardPlan } from "../src/paste-guard.ts";

test("普通缓冲剪掉收尾回车（防粘贴即执行），单行直接写", () => {
  const plan = pasteGuardPlan({
    text: "cargo test\r\n",
    kind: "shell",
    alternateScreen: false,
  });
  assert.equal(plan.action, "write");
  if (plan.action === "write") {
    assert.equal(plan.data, "cargo test");
    assert.equal(plan.note, "已去掉首尾换行");
  }
});

test("缩进保留：行首空格/制表符不剪（粘贴缩进代码不丢缩进）", () => {
  const plan = pasteGuardPlan({
    text: "    indented code",
    kind: "shell",
    alternateScreen: false,
  });
  assert.equal(plan.action, "write");
  if (plan.action === "write") {
    assert.equal(plan.data, "    indented code");
    assert.equal(plan.note, undefined);
  }
});

test("shell 标签多行粘贴先确认，带行数与预览", () => {
  const plan = pasteGuardPlan({
    text: "git status\ngit diff\nnpm test\n",
    kind: "shell",
    alternateScreen: false,
  });
  assert.equal(plan.action, "confirm");
  if (plan.action === "confirm") {
    assert.equal(plan.lines, 3);
    assert.equal(plan.data, "git status\rgit diff\rnpm test");
    assert.match(plan.preview, /git status/);
  }
});

test("agent 标签多行不拦（TUI 自己消化），只修收尾", () => {
  const plan = pasteGuardPlan({
    text: "第一行\n第二行\n",
    kind: "agent",
    alternateScreen: false,
  });
  assert.equal(plan.action, "write");
  if (plan.action === "write") {
    assert.equal(plan.data, "第一行\r第二行");
  }
});

test("备用屏（全屏 TUI）原样写入，不修不拦", () => {
  const plan = pasteGuardPlan({
    text: "keep\r\nme\r\n",
    kind: "shell",
    alternateScreen: true,
  });
  assert.equal(plan.action, "write");
  if (plan.action === "write") assert.equal(plan.data, "keep\rme\r");
});

test("纯换行内容给出提示不写入", () => {
  const plan = pasteGuardPlan({
    text: "\n\n",
    kind: "shell",
    alternateScreen: false,
  });
  assert.equal(plan.action, "write");
  if (plan.action === "write") {
    assert.equal(plan.data, "");
    assert.equal(plan.note, "粘贴内容只有换行");
  }
});
