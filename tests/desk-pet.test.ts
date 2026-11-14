import assert from "node:assert/strict";
import test from "node:test";
import {
  arrivalReaction,
  bubbleText,
  briefWorking,
  newArrivals,
  petItemsFromBrief,
  petItemsFromDesk,
  petPose,
  pickBubble,
  type PetItem,
} from "../src/desk-pet.ts";
import type { DeskItem } from "../src/assistant-queue.ts";
import type { BriefInput } from "../src/assistant-brief.ts";

const P = { path: "/p/her", name: "HER催化综述" };

function desk(over: Partial<DeskItem>): DeskItem {
  return { key: "k", kind: "help", step: 2, where: "第 2 步「精读」", question: "要不要纳入预印本？", options: [], recommend: null, detail: [], ...over };
}

test("等你的事照搬：人工请求能就地点选项，等确认只能去看看，信任菜单只限派出去的活", () => {
  const items = petItemsFromDesk(P, [
    desk({ key: "help:/w:1", kind: "help", options: [{ key: "A", label: "纳入", effect: null }] }),
    desk({ key: "confirm:t1", kind: "confirm", tabId: "t1" }),
    desk({ key: "trust:t2", kind: "trust", tabId: "t2", trust: { yes: "Yes", no: "No", path: null, dispatched: false } }),
    desk({ key: "trust:t3", kind: "trust", tabId: "t3", trust: { yes: "Yes", no: "No", path: null, dispatched: true } }),
    desk({ key: "grant:s:1", kind: "grant" }),
  ]);
  assert.deepEqual(items.map((i) => i.tap), ["reply", null, null, "trust", "grant"]);
  assert.deepEqual(items[0].options, [{ key: "A", label: "纳入" }]);
  assert.deepEqual(items[1].open, { kind: "tab", projectPath: "/p/her", tabId: "t1" });
  assert.equal(items[0].open.kind, "assistant");
  // 键沿用「等你的事」（手机推送同一键），回传时按它找回
  assert.equal(items[0].key, "help:/w:1");
});

test("现在的情况照搬：步骤做完等评审、出错，目标等验收；没做完的目标只提三天内的", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const input: BriefInput = {
    hasFlow: true,
    steps: [
      { n: 1, name: "检索", state: "saved", needsHuman: 0 },
      { n: 2, name: "精读", state: "review", needsHuman: 0 },
      { n: 3, name: "大纲", state: "failed", failure: "退出码 1", needsHuman: 0 },
      { n: 4, name: "初稿", state: "confirm", needsHuman: 0 },
    ],
    goals: [
      { name: "补图", status: "pending_review", updatedAt: "2026-11-09T10:00:00Z" },
      { name: "旧活", status: "failed", updatedAt: "2026-11-01T10:00:00Z" },
      { name: "新活", status: "stopped", updatedAt: "2026-11-08T10:00:00Z" },
    ],
    since: null,
  };
  const items = petItemsFromBrief(P, input, now);
  assert.deepEqual(
    items.map((i) => [i.kind, i.text]),
    [
      ["review", "第 2 步「精读」做完了，等你评审"],
      ["failed", "第 3 步「大纲」出错了"],
      ["review", "目标「补图」做完了，等你验收"],
      ["failed", "目标「新活」没做完"],
    ],
  );
  // 等确认归「等你的事」，这里不重复；键带项目路径，两个项目同名步骤不撞
  assert.ok(items.every((i) => i.key.startsWith("/p/her|")));
  assert.equal(items[1].detail, "退出码 1");
  assert.deepEqual(items[0].open, { kind: "action", projectPath: "/p/her", action: { kind: "review", step: 2, text: "", label: "去评审第 2 步" } });
});

test("有活在做：步骤在跑或目标在跑", () => {
  const base: BriefInput = { hasFlow: true, steps: [], goals: [], since: null };
  assert.equal(briefWorking(base), false);
  assert.equal(briefWorking({ ...base, steps: [{ n: 1, name: "a", state: "working", needsHuman: 0 }] }), true);
  assert.equal(briefWorking({ ...base, goals: [{ name: "g", status: "running", updatedAt: "" }] }), true);
});

const item = (key: string, kind: PetItem["kind"]): PetItem => ({
  key,
  kind,
  projectPath: P.path,
  projectName: P.name,
  where: "第 2 步「精读」",
  text: kind === "review" ? "第 2 步「精读」做完了，等你评审" : "要不要纳入预印本？",
  detail: null,
  options: [],
  recommend: null,
  tap: null,
  open: { kind: "assistant", projectPath: P.path },
});

test("第一次拿到清单不算新来的；之后只冒新来的里最要紧的一件，quiet 不冒", () => {
  const a = item("a", "help");
  const b = item("b", "review");
  const c = item("c", "failed");
  assert.deepEqual(newArrivals(null, [a, b]), []);
  const fresh = newArrivals(new Set(["a"]), [a, b, c]);
  assert.deepEqual(fresh.map((i) => i.key), ["b", "c"]);
  assert.equal(pickBubble(fresh, "important")?.key, "c");
  assert.equal(pickBubble([b, a], "important")?.key, "a");
  assert.equal(pickBubble(fresh, "quiet"), null);
  assert.equal(bubbleText(a, 1), "HER催化综述：第 2 步「精读」在问你：要不要纳入预印本？");
  assert.equal(bubbleText(b, 3), "HER催化综述：第 2 步「精读」做完了，等你评审（还有 2 件）");
});

test("新来的反应：出错垂头丧气优先，做完蹦一下", () => {
  assert.equal(arrivalReaction([item("a", "review"), item("b", "failed")]), "oops");
  assert.equal(arrivalReaction([item("a", "review")]), "happy");
  assert.equal(arrivalReaction([item("a", "help")]), null);
});

test("样子的先后：拖着走 > 反应 > 等你回 > 在想 > 按时间；夜深有事等你也醒着", () => {
  const rest = { pose: "sleep" as const, prop: null };
  assert.equal(petPose({ drag: "left", reaction: "happy", waiting: 2, working: true, rest }).pose, "walkLeft");
  assert.equal(petPose({ drag: null, reaction: "oops", waiting: 2, working: true, rest }).pose, "oops");
  assert.equal(petPose({ drag: null, reaction: null, waiting: 1, working: true, rest }).pose, "wait");
  assert.equal(petPose({ drag: null, reaction: null, waiting: 0, working: true, rest }).pose, "think");
  assert.equal(petPose({ drag: null, reaction: null, waiting: 0, working: false, rest }).pose, "sleep");
  assert.deepEqual(petPose({ drag: null, reaction: null, waiting: 0, working: false, rest: { pose: "idle", prop: "lamp" } }), { pose: "idle", prop: "lamp" });
});

// —— 第二期 ——
import { defaultAskProject, deskOnlyNotes, petLean, petSpeaksInstead } from "../src/desk-pet.ts";

test("桌宠开着且会说话时，等确认 / 人工请求不再另弹系统通知；不说话、勿扰、关着照旧弹", () => {
  const now = 1_000_000;
  assert.equal(petSpeaksInstead({ deskPetEnabled: true }, 0, now), true);
  assert.equal(petSpeaksInstead({ deskPetEnabled: true, deskPetSay: "quiet" }, 0, now), false);
  assert.equal(petSpeaksInstead({ deskPetEnabled: true }, now + 60_000, now), false);
  assert.equal(petSpeaksInstead({ deskPetEnabled: false }, 0, now), false);
  assert.equal(petSpeaksInstead(null, 0, now), false);
});

test("朝鼠标倾身：封顶几度几像素，太近、太远都站正", () => {
  assert.deepEqual(petLean(0, 10), { rotate: 0, x: 0, y: 0 });
  assert.deepEqual(petLean(2000, 0), { rotate: 0, x: 0, y: 0 });
  const right = petLean(600, 0);
  assert.equal(right.rotate, 6);
  assert.equal(right.x, 4);
  const left = petLean(-90, 45);
  assert.equal(left.rotate, -2);
  assert.equal(left.x, -1.5);
  assert.equal(left.y, 0.5);
});

test("问小桌默认问哪个项目：上次的还在用上次的，否则最上面那件事的项目，再否则第一个", () => {
  const feed = { working: false, items: [], projects: [{ path: "/a", name: "A" }, { path: "/b", name: "B" }] };
  assert.equal(defaultAskProject(feed, "/b"), "/b");
  assert.equal(defaultAskProject(feed, "/gone"), "/a");
  assert.equal(defaultAskProject({ ...feed, items: [item("x", "help")] }, null), "/p/her");
  assert.equal(defaultAskProject({ working: false, items: [] }, null), null);
});

test("回答里要回 Mesa 点的东西只说一句", () => {
  assert.deepEqual(deskOnlyNotes({ order: true, rework: false, remember: true, actions: 2 }), ["起草了一张派活单", "起草了一条「以后照这样办」", "给了 2 个去处按钮"]);
  assert.deepEqual(deskOnlyNotes({ order: false, rework: false, remember: 3, actions: 0 }), ["起草了 3 条「以后照这样办」"]);
  assert.deepEqual(deskOnlyNotes({ order: false, rework: false, remember: false, actions: 0 }), []);
});

// —— 安静档 ——
import { petMotion } from "../src/desk-pet.ts";

test("小桌怎么动：拖着走、活泼档一直动；安静档平时动一下就停，Mesa 在前台或勿扰时不动", () => {
  assert.equal(petMotion({ dragging: true, lively: false, mainFocused: true, dnd: true }), "lively");
  assert.equal(petMotion({ dragging: false, lively: true, mainFocused: true, dnd: false }), "lively");
  assert.equal(petMotion({ dragging: false, lively: false, mainFocused: false, dnd: false }), "calm");
  assert.equal(petMotion({ dragging: false, lively: false, mainFocused: true, dnd: false }), "still");
  assert.equal(petMotion({ dragging: false, lively: false, mainFocused: false, dnd: true }), "still");
});
