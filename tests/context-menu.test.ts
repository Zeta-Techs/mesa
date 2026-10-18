import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMenuItems, type ContextMenuItem } from "../src/context-menu.ts";

const labels = (items: ContextMenuItem[]) =>
  items.map((it) => (it.separator ? "—" : it.header ? `#${it.header}` : it.label));

test("危险项与前面的普通项之间自动补一条分隔线", () => {
  const out = normalizeMenuItems([
    { label: "重命名" },
    { label: "复制路径" },
    { label: "删除", danger: true },
  ]);
  assert.deepEqual(labels(out), ["重命名", "复制路径", "—", "删除"]);
});

test("连续危险项成一组，只在组首补一次；已有分隔线不重复补", () => {
  assert.deepEqual(
    labels(
      normalizeMenuItems([
        { label: "移除" },
        { label: "清除痕迹", danger: true },
        { label: "删除目录", danger: true },
      ]),
    ),
    ["移除", "—", "清除痕迹", "删除目录"],
  );
  assert.deepEqual(
    labels(
      normalizeMenuItems([
        { label: "保留" },
        { separator: true },
        { label: "删除", danger: true },
      ]),
    ),
    ["保留", "—", "删除"],
  );
});

test("条件拼装留下的首尾 / 连续分隔线被收掉", () => {
  assert.deepEqual(
    labels(
      normalizeMenuItems([
        { separator: true },
        { label: "查看对话" },
        { separator: true },
        { separator: true },
        { label: "复制路径" },
        { separator: true },
      ]),
    ),
    ["查看对话", "—", "复制路径"],
  );
  assert.deepEqual(normalizeMenuItems([{ separator: true }]), []);
});

test("段头后紧跟危险项不插分隔线；菜单只有危险项时也不插", () => {
  assert.deepEqual(
    labels(normalizeMenuItems([{ header: "危险操作" }, { label: "删除", danger: true }])),
    ["#危险操作", "删除"],
  );
  assert.deepEqual(labels(normalizeMenuItems([{ label: "删除", danger: true }])), ["删除"]);
});
