import assert from "node:assert/strict";
import test from "node:test";
import { filterCommands, matchedKeyword, scoreCommand, type PaletteCommand } from "../src/command-palette.ts";

const COMMANDS: PaletteCommand[] = [
  { id: "page:workspaces", title: "项目", hint: "⌘1", keywords: ["workspaces"] },
  { id: "page:terminal", title: "终端", hint: "⌘2", keywords: ["terminal"] },
  { id: "theme:dracula", title: "主题：Dracula", keywords: ["theme", "主题", "dracula"] },
];

test("filterCommands 空查询返回全部且保持顺序", () => {
  assert.deepEqual(filterCommands(COMMANDS, ""), COMMANDS);
  assert.deepEqual(filterCommands(COMMANDS, "   "), COMMANDS);
});

test("filterCommands 标题中文子串命中", () => {
  const out = filterCommands(COMMANDS, "项目");
  assert.deepEqual(out.map((c) => c.id), ["page:workspaces"]);
});

test("filterCommands keywords 英文别名大小写不敏感", () => {
  const out = filterCommands(COMMANDS, "TERM");
  assert.deepEqual(out.map((c) => c.id), ["page:terminal"]);
});

test("filterCommands 无命中返回空数组", () => {
  assert.deepEqual(filterCommands(COMMANDS, "不存在的东西"), []);
});

const RICH: PaletteCommand[] = [
  { id: "quick-chat", title: "新对话", group: "快速操作", keywords: ["chat", "聊"] },
  { id: "page:workspaces", title: "项目", group: "页面", keywords: ["workspaces"] },
  { id: "page:settings", title: "设置", group: "页面", keywords: ["settings"] },
  { id: "theme:pick", title: "切换主题…", group: "外观", keywords: ["theme", "主题"] },
  { id: "theme:ayu", title: "主题：琥珀", group: "外观", keywords: ["theme", "主题", "ayu"], searchOnly: true },
  { id: "settings:network", title: "设置：网络", group: "设置", keywords: ["network", "代理", "镜像"], searchOnly: true },
  { id: "settings:about", title: "设置：关于", group: "设置", keywords: ["about"], searchOnly: true },
];

test("searchOnly：默认列表不列，搜得到", () => {
  assert.deepEqual(
    filterCommands(RICH, "").map((c) => c.id),
    ["quick-chat", "page:workspaces", "page:settings", "theme:pick"],
  );
  assert.deepEqual(filterCommands(RICH, "琥珀").map((c) => c.id), ["theme:ayu"]);
  assert.deepEqual(filterCommands(RICH, "代理").map((c) => c.id), ["settings:network"]);
});

test("排序：标题开头命中优先，「前缀：名字」的名字开头算开头；组按组内最高分排、组内连续", () => {
  // 「设置」：页面组的「设置」标题全等（100）领先设置组的「设置：网络」（开头 80）
  const out = filterCommands(RICH, "设置");
  assert.deepEqual(out.map((c) => c.id), ["page:settings", "settings:network", "settings:about"]);
  assert.equal(scoreCommand(RICH[4], "琥珀"), 75);
  assert.ok(scoreCommand(RICH[3], "主题") < scoreCommand(RICH[4], "主题"), "开头命中胜过中间命中");
  // 组标题不被打散：同组条目相邻
  const groups = filterCommands(RICH, "主题").map((c) => c.group);
  assert.deepEqual(groups, ["外观", "外观"]);
});

test("散字兜底：两个字以上按序命中算最低分，单字不兜", () => {
  assert.deepEqual(filterCommands(RICH, "设网").map((c) => c.id), ["settings:network"]);
  assert.equal(scoreCommand(RICH[5], "设网"), 20);
  assert.equal(scoreCommand(RICH[0], "z"), 0);
});

test("matchedKeyword：标题没命中才报别名，标题命中或没查询返回 null", () => {
  assert.equal(matchedKeyword(RICH[5], "代理"), "代理");
  assert.equal(matchedKeyword(RICH[5], "网络"), null);
  assert.equal(matchedKeyword(RICH[5], ""), null);
});
