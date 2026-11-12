import assert from "node:assert/strict";
import test from "node:test";
import {
  chatDot,
  chatQuotas,
  chatSlots,
  expandedExtra,
  currentFolderKey,
  folderDot,
  folderOpen,
  foldForks,
  forkParentKey,
  nestForks,
  openTabRows,
  paletteOpenChats,
  parseChatPins,
  parseProjectChatPins,
  isProjectPinned,
  toggleProjectChatPin,
  splitProjectPinned,
  nextPicked,
  nudgeAnchor,
  pinnedChats,
  pinPicked,
  projectChats,
  railNavIndex,
  recentChats,
  toggleChatPin,
  SCRATCH_FOLDER_KEY,
  scratchChats,
  scratchDot,
  sidebarChatTitle,
  staleScratchChats,
  hasReaderChats,
  parseReaderChatsShown,
  toggleReaderChatsShown,
  type ChatRunInput,
} from "../src/sidebar-chats.ts";
import { isThrowawayTab } from "../src/quick-chat.ts";
import type { SessionMetaDto } from "../src/types.ts";

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s-x",
    projectPath: "/repo",
    title: "标题",
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    ...over,
  };
}

function run(over: Partial<ChatRunInput>): ChatRunInput {
  return {
    tabId: "t",
    agentId: "claude-code",
    sessionId: null,
    cwd: "/repo",
    running: true,
    shell: false,
    attention: null,
    ...over,
  };
}

const SCRATCH = "/Users/u/ccode/scratch";

test("侧栏短标题：去掉自动起名的「MMDD|类型|」，别的原样", () => {
  assert.equal(sidebarChatTitle("0924|功能|镁硫电池综述精读笔记步完成"), "镁硫电池综述精读笔记步完成");
  assert.equal(sidebarChatTitle("1023|探索|截图区块内容询问·2"), "截图区块内容询问·2");
  assert.equal(sidebarChatTitle("我自己改的标题"), "我自己改的标题");
  // 类型不在闭集里不算自动起名的前缀
  assert.equal(sidebarChatTitle("2024|年度|总结"), "2024|年度|总结");
  // 只有前缀没有主题时退回原样
  assert.equal(sidebarChatTitle("1023|研究|"), "1023|研究|");
});

test("侧栏短标题：挂在课题下时去掉开头重复的课题名，剩得太短或不是开头就不去", () => {
  assert.equal(sidebarChatTitle("1026|研究|测试项目综述大纲任务书问答敲定", "测试项目"), "综述大纲任务书问答敲定");
  // 课题名后面的分隔符一起去
  assert.equal(sidebarChatTitle("Mesa · 侧栏标签挪位置", "Mesa"), "侧栏标签挪位置");
  assert.equal(sidebarChatTitle("mesa侧栏标签挪位置", "Mesa"), "侧栏标签挪位置", "英文名不分大小写");
  // 剩下不到 4 个字：看不出是哪件事，原样
  assert.equal(sidebarChatTitle("测试项目启动", "测试项目"), "测试项目启动");
  // 不在开头、或没给文件夹名：原样
  assert.equal(sidebarChatTitle("整理测试项目的文献", "测试项目"), "整理测试项目的文献");
  assert.equal(sidebarChatTitle("测试项目综述大纲任务书"), "测试项目综述大纲任务书");
  // 一个字的文件夹名不去（太容易误伤）
  assert.equal(sidebarChatTitle("图表重画与配色", "图"), "图表重画与配色");
});

test("项目的对话：目录就是它或在它的工作树里，按最近活动倒序；归档 / 内部 / 源文件不在的不列", () => {
  const out = projectChats(
    [
      session({ sessionId: "old", updatedAt: "2026-10-20T00:00:00Z" }),
      session({ sessionId: "new", updatedAt: "2026-10-23T00:00:00Z" }),
      session({ sessionId: "wt", projectPath: "/wt/feat-x", updatedAt: "2026-10-22T00:00:00Z" }),
      session({ sessionId: "sub", projectPath: "/repo/sub" }),
      session({ sessionId: "arch", archived: true }),
      session({ sessionId: "int", internal: true }),
      session({ sessionId: "gone", alive: false }),
      session({ sessionId: "nodate", updatedAt: null }),
    ],
    "/repo/",
    ["/wt/feat-x"],
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["new", "wt", "old", "nodate"],
  );
});

test("项目的对话：正在跑的也列（点了切到它的标签），保留的不抢到前面", () => {
  const out = projectChats(
    [
      session({ sessionId: "pinned", pinned: true, updatedAt: "2026-10-01T00:00:00Z" }),
      session({ sessionId: "live", live: true, updatedAt: "2026-10-23T00:00:00Z" }),
    ],
    "/repo",
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["live", "pinned"],
  );
});

test("项目的对话：Windows 大小写 / 分隔符不同也认同一个项目", () => {
  const out = projectChats([session({ projectPath: "c:/Users/u/Repo" })], "C:\\Users\\u\\repo", [], true);
  assert.equal(out.length, 1);
});

test("随手聊的对话：只认 ccode/scratch；随手聊目录被登记成项目后不重复列", () => {
  const sessions = [
    session({ sessionId: "s1", projectPath: SCRATCH }),
    session({ sessionId: "s2", projectPath: "/repo" }),
  ];
  assert.deepEqual(
    scratchChats(sessions, []).map((s) => s.sessionId),
    ["s1"],
  );
  assert.deepEqual(scratchChats(sessions, [`${SCRATCH}/`]), []);
});

test("没起名也没说过话的空对话不进课题 / 随手聊（对话页照列；置顶是人手钉的照列）", () => {
  const empty = session({ sessionId: "e", projectPath: SCRATCH, title: null, summary: null });
  const untitled = session({ sessionId: "u", projectPath: "/repo", title: "未命名对话" });
  const named = session({ sessionId: "n", projectPath: SCRATCH, title: "123321" });
  const custom = session({ sessionId: "c", projectPath: "/repo", title: null, customTitle: "我改的名" });
  const sessions = [empty, untitled, named, custom];
  assert.deepEqual(scratchChats(sessions, []).map((s) => s.sessionId), ["n"]);
  assert.deepEqual(projectChats(sessions, "/repo").map((s) => s.sessionId), ["c"]);
  assert.deepEqual(pinnedChats(sessions, ["claude-code\ne"]).map((s) => s.sessionId), ["e"]);
});

test("开着的对话没起出标题（只说了句「你好」）也列进随手聊 / 课题，行上才有 ⋯", () => {
  const hi = session({ sessionId: "h", projectPath: SCRATCH, title: null, summary: null });
  const untitled = session({ sessionId: "u", projectPath: "/repo", title: null });
  const open = new Set(["claude-code\nh", "claude-code\nu"]);
  assert.deepEqual(scratchChats([hi], [], false, open).map((s) => s.sessionId), ["h"]);
  assert.deepEqual(projectChats([untitled], "/repo", [], false, open).map((s) => s.sessionId), ["u"]);
});

test("随手聊多少天没动的：连空对话一起；外面在跑的、开着的、没有时间的、项目里的都不算", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const old = "2026-10-10T00:00:00Z";
  const sessions = [
    session({ sessionId: "old", projectPath: SCRATCH, updatedAt: old }),
    session({ sessionId: "empty", projectPath: SCRATCH, title: null, updatedAt: old }),
    session({ sessionId: "fresh", projectPath: SCRATCH, updatedAt: "2026-10-25T00:00:00Z" }),
    session({ sessionId: "live", projectPath: SCRATCH, updatedAt: old, live: true }),
    session({ sessionId: "open", projectPath: SCRATCH, updatedAt: old }),
    session({ sessionId: "notime", projectPath: SCRATCH, updatedAt: null }),
    session({ sessionId: "gone", projectPath: SCRATCH, updatedAt: old, alive: false }),
    session({ sessionId: "arch", projectPath: SCRATCH, updatedAt: old, archived: true }),
    session({ sessionId: "proj", projectPath: "/repo", updatedAt: old }),
  ];
  const out = staleScratchChats(sessions, [], new Set(["claude-code\nopen"]), now);
  assert.deepEqual(out.map((s) => s.sessionId), ["old", "empty"]);
  // 天数可调；随手聊目录登记成项目后归项目，不算随手聊
  assert.deepEqual(staleScratchChats(sessions, [], new Set(), now, 30), []);
  assert.deepEqual(staleScratchChats(sessions, [SCRATCH], new Set(), now), []);
});

test("对话状态光标：等你确认 / 在干活 / 开着闲着三种；回落 shell / 已停没有；Mesa 外在写算在干活", () => {
  const s = session({ sessionId: "a" });
  assert.equal(chatDot(s, [run({ sessionId: "a", attention: "confirm" })]), "confirm");
  assert.equal(chatDot(s, [run({ sessionId: "a", attention: "working" })]), "working");
  assert.equal(chatDot(s, [run({ sessionId: "a", attention: "done" })]), "idle");
  assert.equal(chatDot(s, [run({ sessionId: "a", attention: null })]), "idle", "刚起来还没联动上按闲着");
  assert.equal(chatDot(s, [run({ sessionId: "a", shell: true })]), null);
  assert.equal(chatDot(s, [run({ sessionId: "a", running: false })]), null);
  // 同 id 不同家不串
  assert.equal(chatDot(s, [run({ sessionId: "a", agentId: "codex" })]), null);
  assert.equal(chatDot(session({ sessionId: "a", live: true }), []), "working");
  assert.equal(chatDot(s, []), null);
});

test("文件夹状态：工作树里的标签也算这个项目；取最要紧的（等确认 > 干活 > 闲着）", () => {
  const runs = [
    run({ cwd: "/wt/feat-x", attention: "working" }),
    run({ cwd: "/other", attention: "confirm" }),
  ];
  assert.equal(folderDot(["/repo", "/wt/feat-x"], runs), "working");
  assert.equal(folderDot(["/repo"], [run({ cwd: "/repo", attention: "done" })]), "idle");
  assert.equal(
    folderDot(["/repo"], [run({ cwd: "/repo", attention: "done" }), run({ cwd: "/repo", attention: "working" })]),
    "working",
  );
  assert.equal(folderDot(["/repo"], runs), null);
  assert.equal(folderDot(["/other"], runs), "confirm");
  assert.equal(folderDot(["/repo"], [run({ cwd: "/repo", shell: true })]), null);
  assert.equal(scratchDot([run({ cwd: `${SCRATCH}`, attention: "confirm" })]), "confirm");
  assert.equal(scratchDot([run({ cwd: "/repo" })]), null);
});

test("正在看的标签归哪个文件夹：随手聊、最深的项目、工作树归主仓", () => {
  const folders = [
    { root: "/repo", worktrees: ["/wt/feat-x"] },
    { root: "/repo/nested", worktrees: [] },
  ];
  assert.equal(currentFolderKey(SCRATCH, folders, []), SCRATCH_FOLDER_KEY);
  assert.equal(currentFolderKey("/repo/src", folders, []), "/repo");
  assert.equal(currentFolderKey("/repo/nested/a", folders, []), "/repo/nested");
  assert.equal(currentFolderKey("/wt/feat-x", folders, []), "/repo");
  assert.equal(currentFolderKey("/elsewhere", folders, []), null);
  assert.equal(currentFolderKey(null, folders, []), null);
  // 随手聊目录登记成项目后按项目算
  assert.equal(
    currentFolderKey(SCRATCH, [{ root: SCRATCH, worktrees: [] }], [SCRATCH]),
    SCRATCH,
  );
});

test("文件夹展开：人手开关过的按记下的，没碰过的只展开正在聊的", () => {
  assert.equal(folderOpen("/repo", {}, "/repo"), true);
  assert.equal(folderOpen("/repo", {}, "/other"), false);
  assert.equal(folderOpen("/repo", { "/repo": false }, "/repo"), false);
  assert.equal(folderOpen("/repo", { "/repo": true }, null), true);
});

test("从列表点开对话时，刚才那个标签只看没说 / 空白新对话、输入框没字才收", () => {
  const preview = { resumeSessionId: "s1", preview: true };
  assert.equal(isThrowawayTab(preview, null, false), true);
  assert.equal(isThrowawayTab(preview, { running: true }, false), false, "发了以后在跑");
  assert.equal(isThrowawayTab(preview, null, true), false, "输入框里有字");
  assert.equal(
    isThrowawayTab({ resumeSessionId: "s1" }, null, false),
    false,
    "重启后等接回的占位不是这次点开的，不收",
  );
  const blank = { reuseKey: "quickchat:abc" };
  assert.equal(isThrowawayTab(blank, null, false), true);
  assert.equal(isThrowawayTab(blank, { sessionId: "s2" }, false), false);
  assert.equal(isThrowawayTab({ reuseKey: "project-chat:x" }, null, false), false, "别的入口开的空白标签不收");
});

test("各文件夹列几段：每个至少 5 段，侧栏有空位从上往下补满，不超过自己有的", () => {
  // 没量到高度（0 行空位）：每个 5 段
  assert.deepEqual(chatQuotas({ counts: [12, 3, 40], extra: [0, 0, 0], slots: 0 }), [5, 3, 5]);
  // 放得下 20 行：先各给 5 / 3 / 5，剩 7 行从上往下补
  assert.deepEqual(chatQuotas({ counts: [12, 3, 40], extra: [0, 0, 0], slots: 20 }), [12, 3, 5]);
  // 放得下 30 行：第一个补满 12 之后剩下的给第三个
  assert.deepEqual(chatQuotas({ counts: [12, 3, 40], extra: [0, 0, 0], slots: 30 }), [12, 3, 15]);
  // 点过展开更多的那个先按 5 + extra 算，空位仍从上往下补
  assert.deepEqual(chatQuotas({ counts: [12, 3, 40], extra: [0, 0, 20], slots: 20 }), [5, 3, 25]);
  // 什么都没有
  assert.deepEqual(chatQuotas({ counts: [], extra: [], slots: 10 }), []);
});

test("侧栏放得下几行：减掉节头等固定高度按行高折算，没量到时是 0", () => {
  assert.equal(chatSlots({ available: 600, fixed: 120, rowHeight: 29 }), 16);
  assert.equal(chatSlots({ available: 100, fixed: 120, rowHeight: 29 }), 0);
  assert.equal(chatSlots({ available: 0, fixed: 0, rowHeight: 29 }), 0);
});

test("展开更多：在眼下列着的段数上再多 10 段", () => {
  // 空位补到列着 12 段：再多 10 段 → 5 + 17 = 22
  assert.equal(expandedExtra(12), 17);
  assert.equal(chatQuotas({ counts: [40], extra: [expandedExtra(12)], slots: 0 })[0], 22);
  assert.equal(expandedExtra(5), 10);
});

test("开着、但列表里还没有的：新对话 / 纯终端 / 刚起来的 Agent 挂到所属文件夹；已有对话行的不重复，没起进程的只列正看着的", () => {
  const base = { agentId: "claude-code", sessionId: null, cwd: "/repo", running: false, shell: false, attention: null, title: "" };
  const rows = openTabRows({
    runs: [
      { ...base, tabId: "blank", title: "随手聊", cwd: SCRATCH },
      { ...base, tabId: "blank-bg", cwd: SCRATCH },
      { ...base, tabId: "sh", shell: true, title: "zsh" },
      { ...base, tabId: "agent", running: true, attention: "confirm", title: "Claude Code" },
      { ...base, tabId: "listed", running: true, sessionId: "s1", title: "已经在列表里" },
      { ...base, tabId: "else", running: true, cwd: "/elsewhere", sessionId: "s9", title: "别处" },
    ],
    listed: new Set(["claude-code\ns1"]),
    focusedTabId: "blank",
    folderOf: (cwd) => (cwd === SCRATCH ? SCRATCH_FOLDER_KEY : cwd === "/repo" ? "/repo" : null),
  });
  assert.deepEqual(
    rows.map((r) => [r.tabId, r.kind, r.label, r.dot, r.folderKey]),
    [
      ["blank", "new", "新对话", null, SCRATCH_FOLDER_KEY],
      ["sh", "terminal", "zsh", null, "/repo"],
      ["agent", "chat", "新对话", "confirm", "/repo"],
      ["else", "chat", "别处", "idle", null],
    ],
  );
});

test("置顶的对话：按置顶先后列，归档 / 源文件不在的不列；坏的存档读成空", () => {
  const a = session({ sessionId: "a", updatedAt: "2026-10-01" });
  const b = session({ sessionId: "b", updatedAt: "2026-10-20" });
  const gone = session({ sessionId: "c", alive: false });
  let pins = toggleChatPin([], "claude-code\nb");
  pins = toggleChatPin(pins, "claude-code\na");
  pins = toggleChatPin(pins, "claude-code\nc");
  assert.deepEqual(pinnedChats([a, b, gone], pins).map((s) => s.sessionId), ["b", "a"]);
  assert.deepEqual(toggleChatPin(pins, "claude-code\nb"), ["claude-code\na", "claude-code\nc"], "再点一次取消");
  assert.deepEqual(parseChatPins(JSON.stringify(pins)), pins);
  assert.deepEqual(parseChatPins("{坏"), []);
  assert.deepEqual(parseChatPins(null), []);
});

test("侧栏键盘走：↑↓ 一行、到头不绕回，Home / End 到头尾，不在行上时从两头起", () => {
  assert.equal(railNavIndex("ArrowDown", 2, 5), 3);
  assert.equal(railNavIndex("ArrowDown", 4, 5), 4);
  assert.equal(railNavIndex("ArrowUp", 0, 5), 0);
  assert.equal(railNavIndex("ArrowDown", -1, 5), 0);
  assert.equal(railNavIndex("ArrowUp", -1, 5), 4);
  assert.equal(railNavIndex("Home", 3, 5), 0);
  assert.equal(railNavIndex("End", 0, 5), 4);
  assert.equal(railNavIndex("Enter", 0, 5), null);
  assert.equal(railNavIndex("ArrowDown", 0, 0), null);
});

test("命令面板「打开的对话」：侧栏列着的也列（侧栏这时看不见）；等确认 > 干活 > 其余按开的顺序，正看着的沉底", () => {
  const base = { agentId: "claude-code", sessionId: null, cwd: "/repo", running: false, shell: false, attention: null, title: "" };
  const rows = paletteOpenChats(
    [
      { ...base, tabId: "cur", running: true, sessionId: "s0", attention: "done", title: "正看着" },
      { ...base, tabId: "idle", running: true, sessionId: "s1", attention: "done", title: "闲着" },
      { ...base, tabId: "blank-bg" },
      { ...base, tabId: "work", running: true, sessionId: "s2", attention: "working", title: "1024|研究|干活" },
      { ...base, tabId: "sh", shell: true, title: "zsh" },
      { ...base, tabId: "ask", running: true, sessionId: "s3", attention: "confirm", title: "等确认" },
      { ...base, tabId: "preview", sessionId: "s4", title: "只看了记录" },
    ],
    "cur",
  );
  assert.deepEqual(
    rows.map((r) => [r.tabId, r.caret, r.current]),
    [
      ["ask", "confirm", false],
      ["work", "working", false],
      ["idle", "idle", false],
      ["sh", null, false],
      ["cur", "idle", true],
    ],
  );
  const work = rows.find((r) => r.tabId === "work")!;
  assert.equal(work.label, "干活", "同侧栏去掉「MMDD|类型|」");
  assert.equal(work.fullTitle, "1024|研究|干活");
});

test("灵动岛「最近对话」：只列侧栏能列的、没开着的，新到旧，限条数", () => {
  const list = [
    session({ sessionId: "old", updatedAt: "2026-10-01T00:00:00Z" }),
    session({ sessionId: "new", updatedAt: "2026-10-30T00:00:00Z" }),
    session({ sessionId: "mid", updatedAt: "2026-10-15T00:00:00Z" }),
    session({ sessionId: "open", updatedAt: "2026-10-29T00:00:00Z" }),
    session({ sessionId: "arch", updatedAt: "2026-10-29T00:00:00Z", archived: true }),
    session({ sessionId: "gone", updatedAt: "2026-10-29T00:00:00Z", alive: false }),
    session({ sessionId: "same-id", agent: "codex", updatedAt: "2026-10-28T00:00:00Z" }),
  ];
  const runs: ChatRunInput[] = [
    { tabId: "t", agentId: "claude-code", sessionId: "open", cwd: "/repo", running: true, shell: false, attention: null },
    { tabId: "t2", agentId: "claude-code", sessionId: "same-id", cwd: "/repo", running: true, shell: false, attention: null },
  ];
  assert.deepEqual(recentChats(list, runs).map((s) => s.sessionId), ["new", "same-id", "mid", "old"], "同 id 别家的不算开着");
  assert.deepEqual(recentChats(list, runs, 2).map((s) => s.sessionId), ["new", "same-id"]);
});

test("多选：⌘ 点加进 / 拿出，⇧ 点从起点到这一行整段换上（上下都行），起点不在眼下列着的里只选这一行", () => {
  const order = ["a", "b", "c", "d", "e"];
  let p = nextPicked(new Set(), order, "b", null, "toggle");
  assert.deepEqual([...p], ["b"]);
  p = nextPicked(p, order, "d", "b", "toggle");
  assert.deepEqual([...p].sort(), ["b", "d"]);
  p = nextPicked(p, order, "b", "d", "toggle");
  assert.deepEqual([...p], ["d"]);
  assert.deepEqual([...nextPicked(p, order, "b", "d", "range")], ["b", "c", "d"]);
  assert.deepEqual([...nextPicked(p, order, "e", "c", "range")], ["c", "d", "e"]);
  assert.deepEqual([...nextPicked(p, order, "c", "gone", "range")], ["c"]);
  assert.deepEqual([...nextPicked(p, order, "c", null, "range")], ["c"]);
});

test("多选置顶：有没钉的就把没钉的接在后面，全都钉着才一起取消", () => {
  assert.deepEqual(pinPicked(["x", "a"], ["a", "b", "c"]), ["x", "a", "b", "c"]);
  assert.deepEqual(pinPicked(["x", "a", "b"], ["a", "b"]), ["x"]);
});

test("多选提醒贴哪：刚处理那段的下一段，没有就上一段（2026-10-27）", () => {
  assert.equal(nudgeAnchor(["a", "b", "c"], "b"), "c");
  assert.equal(nudgeAnchor(["a", "b", "c"], "c"), "b");
  assert.equal(nudgeAnchor(["a"], "a"), null);
  assert.equal(nudgeAnchor(["a"], "x"), null);
});

test("forkParentKey：CLI 真分叉与 Mesa 同家接力算分叉，跨家接力不算", () => {
  assert.equal(forkParentKey(session({ sessionId: "b", forkedFrom: "a" })), "claude-code\na");
  assert.equal(
    forkParentKey(session({ sessionId: "b", handoffFromAgent: "claude-code", handoffFromSession: "a" })),
    "claude-code\na",
  );
  assert.equal(forkParentKey(session({ sessionId: "b", handoffFromAgent: "codex", handoffFromSession: "a" })), null);
  assert.equal(forkParentKey(session({ sessionId: "b" })), null);
});

test("nestForks：分叉紧跟原对话，一家子排在最近动过的那段的位置", () => {
  // 输入按最近活动倒序：分叉 b 最新，原对话 a 在最后
  const chats = [
    session({ sessionId: "b", forkedFrom: "a" }),
    session({ sessionId: "x" }),
    session({ sessionId: "c", handoffFromAgent: "claude-code", handoffFromSession: "a" }),
    session({ sessionId: "d", forkedFrom: "b" }),
    session({ sessionId: "a" }),
  ];
  const rows = nestForks(chats);
  assert.deepEqual(
    rows.map((r) => [r.s.sessionId, r.depth, r.forks]),
    [
      ["a", 0, 3],
      ["b", 1, 1],
      ["d", 2, 0],
      ["c", 1, 0],
      ["x", 0, 0],
    ],
  );
});

test("nestForks：原对话不在这份列表里、或绕成环的照常顶格", () => {
  const rows = nestForks([
    session({ sessionId: "b", forkedFrom: "gone" }),
    session({ sessionId: "p", forkedFrom: "q" }),
    session({ sessionId: "q", forkedFrom: "p" }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.s.sessionId, r.depth]),
    [
      ["b", 0],
      ["p", 0],
      ["q", 0],
    ],
  );
});

test("foldForks：收起只藏分叉，正看着的那段照样列", () => {
  const rows = nestForks([
    session({ sessionId: "b", forkedFrom: "a" }),
    session({ sessionId: "c", forkedFrom: "a" }),
    session({ sessionId: "a" }),
    session({ sessionId: "x" }),
  ]);
  const folded = new Set(["claude-code\na"]);
  assert.deepEqual(foldForks(rows, folded).map((r) => r.s.sessionId), ["a", "x"]);
  assert.deepEqual(foldForks(rows, folded, "claude-code\nc").map((r) => r.s.sessionId), ["a", "c", "x"]);
  assert.deepEqual(foldForks(rows, new Set()).map((r) => r.s.sessionId), ["a", "b", "c", "x"]);
});

test("项目内置顶：流程对话自动在前按开工先后，人手钉的跟在后面，其余保持最近活动顺序", () => {
  const outline = session({ sessionId: "o", stepName: "综述大纲", createdAt: "2026-11-03", updatedAt: "2026-11-03" });
  const search = session({ sessionId: "a", stepName: "文献检索", createdAt: "2026-11-01", updatedAt: "2026-11-04" });
  const free1 = session({ sessionId: "f1", updatedAt: "2026-11-05" });
  const free2 = session({ sessionId: "f2", updatedAt: "2026-11-02" });
  const pins = { pinned: ["claude-code\nf2"], dropped: [] };
  const { pinned, rest } = splitProjectPinned([free1, search, outline, free2], pins);
  assert.deepEqual(pinned.map((s) => s.sessionId), ["a", "o", "f2"]);
  assert.deepEqual(rest.map((s) => s.sessionId), ["f1"]);
});

test("项目内置顶：流程对话取消记 dropped、再钉回撤掉；普通对话进出 pinned", () => {
  const step = session({ sessionId: "s", stepName: "精读" });
  const free = session({ sessionId: "f" });
  let pins = parseProjectChatPins(null);
  assert.equal(isProjectPinned(step, pins), true);
  assert.equal(isProjectPinned(free, pins), false);
  pins = toggleProjectChatPin(pins, step);
  assert.deepEqual(pins, { pinned: [], dropped: ["claude-code\ns"] });
  assert.equal(isProjectPinned(step, pins), false);
  pins = toggleProjectChatPin(pins, step);
  assert.deepEqual(pins.dropped, []);
  pins = toggleProjectChatPin(pins, free);
  assert.deepEqual(pins.pinned, ["claude-code\nf"]);
  pins = toggleProjectChatPin(pins, free);
  assert.deepEqual(pins.pinned, []);
});

test("项目内置顶：坏数据当空表", () => {
  assert.deepEqual(parseProjectChatPins("not json"), { pinned: [], dropped: [] });
  assert.deepEqual(parseProjectChatPins('{"pinned":[1,"a\\nb","x"]}'), { pinned: ["a\nb"], dropped: [] });
});

test("精读对话默认不在课题下列，项目菜单打开后照列；开着的精读标签同样跟着开关（2026-11-06）", () => {
  const sessions = [
    session({ sessionId: "mine", updatedAt: "2026-11-06T02:00:00Z" }),
    session({ sessionId: "read", reader: true, readerPdf: "/repo/papers/a.pdf", updatedAt: "2026-11-06T03:00:00Z" }),
    session({ sessionId: "old", reader: true, readerPdf: null, updatedAt: "2026-11-06T01:00:00Z" }),
  ];
  assert.deepEqual(projectChats(sessions, "/repo").map((s) => s.sessionId), ["mine"]);
  assert.deepEqual(
    projectChats(sessions, "/repo", [], false, new Set(), true).map((s) => s.sessionId),
    ["read", "mine", "old"],
  );
  assert.equal(hasReaderChats(sessions, "/repo"), true);
  assert.equal(hasReaderChats(sessions, "/other"), false);

  const base = { agentId: "claude-code", running: true, shell: false, attention: null, sessionId: null };
  const tabs = [{ ...base, tabId: "r", cwd: "/repo", title: "阅读 · a", reuseKey: "reader:/repo\n/repo/papers/a.pdf" }];
  const folderOf = (cwd: string) => (cwd === "/repo" ? "/repo" : null);
  const hidden = openTabRows({ runs: tabs, listed: new Set(), focusedTabId: null, folderOf, showReader: () => false });
  assert.equal(hidden.length, 0);
  const shown = openTabRows({ runs: tabs, listed: new Set(), focusedTabId: null, folderOf, showReader: (k) => k === "/repo" });
  assert.deepEqual(shown.map((r) => r.tabId), ["r"]);
});

test("精读对话开关按课题记、坏值不炸", () => {
  assert.deepEqual(parseReaderChatsShown("oops"), []);
  assert.deepEqual(parseReaderChatsShown('["/a", 3, ""]'), ["/a"]);
  assert.deepEqual(toggleReaderChatsShown(["/a"], "/b"), ["/a", "/b"]);
  assert.deepEqual(toggleReaderChatsShown(["/a", "/b"], "/a"), ["/b"]);
});

test("groupStepChats：按步骤分组、按角色起行名，分路收进子组（2026-11-10）", async () => {
  const { groupStepChats, stepRoleLabel, circledIndex, defaultOpenStep } = await import("../src/sidebar-chats.ts");
  const row = (over: Partial<SessionMetaDto>) => ({ s: session(over), depth: 0, forks: 0 });
  const rows = [
    row({ sessionId: "n-merge", stepName: "文献精读与笔记", stepIndex: 2, stepRole: "merge", createdAt: "2026-11-10T11:34:00Z" }),
    row({ sessionId: "n-l3", stepName: "文献精读与笔记", stepIndex: 2, stepRole: "lane", laneNo: 3, laneDone: true, createdAt: "2026-11-10T10:59:20Z" }),
    row({ sessionId: "n-l2", stepName: "文献精读与笔记", stepIndex: 2, stepRole: "lane", laneNo: 2, laneDone: false, createdAt: "2026-11-10T10:59:19Z" }),
    row({ sessionId: "n-d", stepName: "文献精读与笔记", stepIndex: 2, stepRole: "discuss", createdAt: "2026-11-10T10:32:00Z" }),
    row({ sessionId: "n-follow", stepName: "文献精读与笔记", stepIndex: 2, stepRole: "round", roundKind: "followup", createdAt: "2026-11-10T16:08:00Z" }),
    row({ sessionId: "s-rework", stepName: "文献检索与筛选", stepIndex: 1, stepRole: "round", roundKind: "rework", createdAt: "2026-11-10T14:31:00Z" }),
    row({ sessionId: "s-w1", stepName: "文献检索与筛选", stepIndex: 1, stepRole: "work", createdAt: "2026-11-09T15:20:00Z" }),
    row({ sessionId: "s-w2", stepName: "文献检索与筛选", stepIndex: 1, stepRole: "work", createdAt: "2026-11-10T09:39:00Z" }),
    row({ sessionId: "s-user", stepName: "文献检索与筛选", stepIndex: 1, stepRole: "discuss", titleByUser: true, createdAt: "2026-11-09T13:00:00Z" }),
    row({ sessionId: "s-unknown", stepName: "文献检索与筛选", stepIndex: 1, createdAt: "2026-11-09T12:00:00Z" }),
    row({ sessionId: "pin", createdAt: "2026-11-01T00:00:00Z" }),
  ];
  const { groups, manual } = groupStepChats(rows);
  assert.deepEqual(manual.map((r) => r.s.sessionId), ["pin"]);
  assert.deepEqual(groups.map((g) => [g.index, g.step]), [[1, "文献检索与筛选"], [2, "文献精读与笔记"]]);
  // 检索：人改过名的照写标题（null），认不出角色的 null；两段「执行任务书」各接日期
  assert.deepEqual(groups[0].rows.map((r) => r.label), [null, null, "执行任务书 · 11-09", "执行任务书 · 11-10", "补料轮"]);
  assert.equal(groups[0].lanes, null);
  assert.deepEqual(groups[0].after, []);
  // 精读：商量在外面，分路子组按路号、收尾最后，做完几路
  assert.deepEqual(groups[1].rows.map((r) => r.label), ["商量任务书"]);
  assert.deepEqual(groups[1].lanes!.rows.map((r) => [r.label, r.done]), [["第 2 路", false], ["第 3 路", true], ["收尾", false]]);
  assert.equal(groups[1].lanes!.total, 2);
  assert.equal(groups[1].lanes!.done, 1);
  // 分路之后开的跟进轮写起因、画在分路子组下面（不是第二个「收尾」）
  assert.deepEqual(groups[1].after.map((r) => r.label), ["跟进轮"]);
  assert.equal(stepRoleLabel(session({ stepRole: "round", roundKind: "bogus" })), null);
  assert.equal(stepRoleLabel(session({ stepRole: "lane", laneNo: null })), null);
  assert.equal(circledIndex(2), "②");
  assert.equal(circledIndex(21), "21.");
  assert.equal(circledIndex(null), "");
  // 默认开：在跑的那组；没有在跑的开最近动过的
  assert.equal(defaultOpenStep(groups, (s) => s.sessionId === "s-w1"), "文献检索与筛选");
  assert.equal(defaultOpenStep(groups, () => false), "文献精读与笔记");
});

test("从步骤开的标签会话认出来前就挂在那一步下面（2026-11-12）", async () => {
  const { groupStepChats, defaultOpenStep, openTabStep } = await import("../src/sidebar-chats.ts");
  const base = { agentId: "claude-code", running: true, shell: false, attention: null, sessionId: null };
  const folderOf = (cwd: string) => (cwd.startsWith("/repo") ? "/repo" : null);
  const draft = { name: "综述初稿", index: 4 };
  const tabs = openTabRows({
    runs: [
      { ...base, tabId: "d", cwd: "/repo", title: "综述初稿 · 任务书", reuseKey: "discuss:/repo:.ccode/drafts/x.md", railStep: draft },
      { ...base, tabId: "w", cwd: "/repo/wt/draft", title: "综述初稿", reuseKey: "ws:/repo/wt/draft", railStep: draft },
      { ...base, tabId: "l2", cwd: "/repo/wt/notes", title: "精读 · 第 2 路", reuseKey: "ws:/repo/wt/notes#lane-2", railStep: { name: "文献精读与笔记", index: 2 } },
      { ...base, tabId: "l1", cwd: "/repo/wt/notes", title: "精读 · 第 1 路", reuseKey: "ws:/repo/wt/notes#lane-1", railStep: { name: "文献精读与笔记", index: 2 } },
      { ...base, tabId: "x", cwd: "/repo/wt/draft", title: "复核：综述初稿", reuseKey: "review:/repo/wt/draft", railStep: draft },
      { ...base, tabId: "t", cwd: "/repo", title: "终端", shell: true, running: false, railStep: draft },
      { ...base, tabId: "plain", cwd: "/repo", title: "随手问" },
    ],
    listed: new Set(),
    focusedTabId: "d",
    folderOf,
  });
  // 终端、不带步骤的不进组
  assert.deepEqual(tabs.filter((t) => t.step).map((t) => t.tabId), ["d", "w", "l2", "l1", "x"]);
  const row = (over: Partial<SessionMetaDto>) => ({ s: session(over), depth: 0, forks: 0 });
  const rows = [row({ sessionId: "s-w", stepName: "文献检索与筛选", stepIndex: 1, stepRole: "work", createdAt: "2026-11-09T15:20:00Z" })];
  const { groups } = groupStepChats(rows, tabs);
  // 这一步还没有对话也建组，步骤号取标签带的
  assert.deepEqual(groups.map((g) => [g.index, g.step]), [[1, "文献检索与筛选"], [2, "文献精读与笔记"], [4, "综述初稿"]]);
  const draftGroup = groups[2];
  assert.deepEqual(draftGroup.tabs.head.map((t) => [t.tab.tabId, t.label]), [["d", "商量任务书"]]);
  // 首轮干活写「执行任务书」，别的复用键照写标题
  assert.deepEqual(draftGroup.tabs.tail.map((t) => [t.tab.tabId, t.label]), [["w", "执行任务书"], ["x", null]]);
  // 分路进分路子组、按路号
  assert.deepEqual(groups[1].tabs.lanes.map((t) => [t.tab.tabId, t.label]), [["l1", "第 1 路"], ["l2", "第 2 路"]]);
  assert.equal(groups[1].lanes!.total, 2);
  assert.equal(groups[1].lanes!.done, 0);
  // 已有干活的步骤再开一段：认不出起因，先写「新一轮」
  const later = groupStepChats(rows, [{ ...tabs[1], step: { ...tabs[1].step!, name: "文献检索与筛选", index: 1 } }]);
  assert.deepEqual(later.groups[0].tabs.tail.map((t) => t.label), ["新一轮"]);
  // 收尾（同干活的复用键，靠标记认）：有分路时进分路子组，排在各路后面
  const merge = openTabStep({ name: "文献精读与笔记", index: 2, role: "merge" }, "ws:/repo/wt/notes");
  const withMerge = groupStepChats([], [...tabs.slice(2, 4), { ...tabs[1], tabId: "m", step: merge }]);
  assert.deepEqual(withMerge.groups[0].tabs.lanes.map((t) => t.label), ["第 1 路", "第 2 路", "收尾"]);
  // 刚开的标签所在的组默认开着
  assert.equal(defaultOpenStep(groups, () => false, (t) => t.tabId === "d"), "综述初稿");
  assert.equal(openTabStep(null, "discuss:/repo:x"), null);
});
