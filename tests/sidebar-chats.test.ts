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
  openTabRows,
  paletteOpenChats,
  parseChatPins,
  nextPicked,
  nudgeAnchor,
  pinnedChats,
  pinPicked,
  projectChats,
  railNavIndex,
  toggleChatPin,
  SCRATCH_FOLDER_KEY,
  scratchChats,
  scratchDot,
  sidebarChatTitle,
  staleScratchChats,
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
