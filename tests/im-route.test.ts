import assert from "node:assert/strict";
import test from "node:test";
import { findProject, routeMessage } from "../src/im-route.ts";
import { OP_TIERS, actionOp, opAllowed } from "../src/assistant-ops.ts";

const A = { path: "/p/a", name: "药物毒性" };
const B = { path: "/p/b", name: "综述 单细胞" };
const C = { path: "/p/c", name: "综述 免疫" };
const all = [A, B, C];

test("总助手路由：命令、点名、切换、默认项目、说不清就让人选", () => {
  assert.deepEqual(routeMessage("帮助", all, null), { kind: "help" });
  assert.deepEqual(routeMessage("等我的", all, null), { kind: "queue" });
  assert.deepEqual(routeMessage("项目", all, null), { kind: "list" });
  assert.deepEqual(routeMessage("切到 单细胞", all, null), { kind: "switch", project: B });
  assert.deepEqual(routeMessage("切到 综述", all, null), { kind: "unknown_project", name: "综述" }, "两个都像不猜");
  assert.deepEqual(routeMessage("药物毒性：下周组会准备一下", all, null), { kind: "ask", project: A, text: "下周组会准备一下" });
  assert.deepEqual(routeMessage("@免疫 出一份周报", all, null), { kind: "ask", project: C, text: "出一份周报" });
  assert.deepEqual(routeMessage("出一份周报", all, A), { kind: "ask", project: A, text: "出一份周报" });
  assert.deepEqual(routeMessage("出一份周报", all, null), { kind: "pick", text: "出一份周报" });
  assert.deepEqual(routeMessage("出一份周报", [A], null), { kind: "ask", project: A, text: "出一份周报" });
  assert.deepEqual(routeMessage("回第 2 步 剔除那两孔", all, A), { kind: "reply", project: A, step: 2, text: "剔除那两孔" });
  assert.deepEqual(routeMessage("药物毒性：回第3步：灰度", all, null), { kind: "reply", project: A, step: 3, text: "灰度" });
  assert.deepEqual(routeMessage("时间：明天", all, A), { kind: "ask", project: A, text: "时间：明天" }, "冒号前不是项目名就整句交给当前项目");
  assert.equal(findProject("不存在", all), null);
});

test("动作分级：手机上只做点一下就生效那一档", () => {
  assert.equal(opAllowed("dispatch", "phone"), true);
  assert.equal(opAllowed("help_answer", "phone"), true);
  assert.equal(opAllowed("remember", "phone"), true);
  assert.equal(opAllowed("trust_folder", "phone"), true, "信任文件夹放到手机上点（只限派出去的活，由调用方再核对）");
  for (const op of ["confirm_command", "adopt_review", "write_back", "delete", "navigate", "rework"] as const) {
    assert.equal(opAllowed(op, "phone"), false, op);
    assert.equal(opAllowed(op, "desktop"), true, op);
  }
  assert.equal(actionOp("mail"), "relay");
  assert.equal(actionOp("review"), "navigate");
  assert.equal(OP_TIERS.answer, "auto");
  // 授权请求只放宽这一次：手机上点一下就生效；改授权（以后都放宽）不在这一档
  assert.equal(OP_TIERS.grant_once, "tap");
  assert.equal(opAllowed("grant_once", "phone"), true);
});

test("「派出去」「接着做」照字面认，不交给 AI", async () => {
  const { quickIntent } = await import("../src/im-route.ts");
  for (const t of ["派出去", "派吧", "开工", "派出去吧"]) assert.equal(quickIntent(t), "dispatch", t);
  for (const t of ["让他接着做", "接着做", "继续", "让它继续吧"]) assert.equal(quickIntent(t), "resume", t);
  for (const t of ["派出去之前先问一下", "继续写第二节", "帮我写周报"]) assert.equal(quickIntent(t), null, t);
});
