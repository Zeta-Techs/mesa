import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLitLibrary,
  isPapersTarget,
  papersImportFocus,
  stepNodeAction,
  stepNodeReady,
  stepNodeWaiting,
  type StepNodeActionContext,
} from "../src/step-node-actions.ts";
import type { StepFlowNode } from "../src/step-flow.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";
import type { HumanTaskDto, HumanTaskStateDto } from "../src/types.ts";

/**
 * 步骤节点行的动作选择。
 *
 * 这些判据原先在 StepFlow.tsx 的 JSX 里，只能靠点界面验证——「付费墙补充入口消失」
 * 和「EndNote 同步入口消失」都是这么坏掉又这么修好的。搬到纯函数里就能钉住，
 * 顺手把最容易分叉的一条（就绪口径三处共用）也钉上。
 */

function humanState(
  over: Partial<HumanTaskStateDto> & { title: string },
): HumanTaskStateDto {
  return {
    step: "s",
    guidance: "",
    target: "",
    timing: "before",
    detected: false,
    manual: false,
    explicitCancel: false,
    done: false,
    ...over,
  };
}

function humanNode(
  human: HumanTaskStateDto,
  over: Partial<StepFlowNode> = {},
): StepFlowNode {
  return {
    key: `human:${human.title}`,
    kind: "human",
    section: "main",
    label: human.title,
    done: human.done,
    human,
    ...over,
  };
}

function node(
  kind: StepFlowNode["kind"],
  over: Partial<StepFlowNode> = {},
): StepFlowNode {
  return { key: kind, kind, section: "main", label: kind, done: false, ...over };
}

function ctx(over: Partial<StepNodeActionContext> = {}): StepNodeActionContext {
  return {
    runStatus: "pending",
    agentAttention: null,
    litSource: "",
    hasWorkspace: true,
    reviewConflict: false,
    canRestore: false,
    readPaper: false,
    readPaperPrimary: false,
    ...over,
  };
}

test("落点判据只认 papers/ 前缀，反斜杠归一", () => {
  assert.equal(isPapersTarget("papers/to-fetch.md"), true);
  assert.equal(isPapersTarget("papers\\to-fetch.md"), true);
  assert.equal(isPapersTarget("papers"), false, "目录名不带斜杠不算文献落点");
  assert.equal(isPapersTarget("notes/papers.md"), false);
  assert.equal(isPapersTarget(undefined), false);
  assert.equal(isPapersTarget(""), false);
});

test("进料口高亮按文献来源映射，未声明则不高亮", () => {
  assert.equal(papersImportFocus("zotero"), "zotero");
  assert.equal(papersImportFocus("endnote"), "files");
  assert.equal(papersImportFocus("folder"), "files");
  assert.equal(papersImportFocus("search"), undefined);
  assert.equal(papersImportFocus(undefined), undefined);
});

test("有文献库的三个来源算「已有库」，检索来源不算", () => {
  for (const s of ["zotero", "endnote", "folder"]) {
    assert.equal(hasLitLibrary(s), true, s);
  }
  for (const s of ["search", "", undefined]) {
    assert.equal(hasLitLibrary(s), false, String(s));
  }
});

test("就绪口径四选一：待评审 / 已保存 / 会话跑完 / 清单已现算到", () => {
  const noCount = { expectedCount: undefined };
  assert.equal(stepNodeReady("review", null, noCount), true);
  assert.equal(stepNodeReady("done", null, noCount), true);
  assert.equal(stepNodeReady("active", "done", noCount), true);
  assert.equal(stepNodeReady("active", null, { expectedCount: 12 }), true);
  // 未就绪的三种：没开工、在出字、在等确认
  assert.equal(stepNodeReady("pending", null, noCount), false);
  assert.equal(stepNodeReady("active", "working", noCount), false);
  assert.equal(stepNodeReady("active", "confirm", noCount), false);
});

test("压暗与就绪是同一口径的反面：就绪的行不压暗", () => {
  const h = { timing: "after", title: "下载付费墙文献全文" };
  for (const [status, attention, expected] of [
    ["review", null, false],
    ["done", null, false],
    ["active", "done", false],
    ["active", "working", true],
    ["pending", null, true],
  ] as const) {
    assert.equal(
      stepNodeWaiting(status, attention, { ...h, expectedCount: undefined }, false),
      expected,
      `${status}/${attention}`,
    );
  }
  // 已完成的行不压暗
  assert.equal(
    stepNodeWaiting("active", "working", { ...h, expectedCount: undefined }, true),
    false,
  );
  // 待确认清单已经挂在这一行上，不能因为检索会话没标完成就发灰
  assert.equal(
    stepNodeWaiting(
      "active",
      "working",
      { ...h, title: "核对待确认篇目", expectedCount: undefined },
      false,
    ),
    false,
  );
  assert.equal(
    stepNodeWaiting(
      "active",
      "working",
      { ...h, title: "逐条决定审查报告", target: "manuscript/review-report.md", expectedCount: undefined },
      false,
    ),
    false,
  );
});

test("human：去笔记夹与资料库同步排在就绪门之前，未就绪时给灰着的按钮", () => {
  // 这两个节点是保存进项目之后的收尾动作，位置要先占住；普通 after 事项未就绪时压根不出现
  const pending = ctx({ runStatus: "active", agentAttention: "working" });
  assert.deepEqual(stepNodeAction(node("human", { key: "continue-notes" }), pending), {
    kind: "continue-notes",
    enabled: false,
  });
  assert.deepEqual(stepNodeAction(node("human", { key: "endnote-export" }), pending), {
    kind: "endnote-sync",
    enabled: false,
  });
  // 同样的上下文中，普通 after 事项没有入口
  assert.equal(
    stepNodeAction(
      humanNode(humanState({ title: "填学校格式规范", timing: "after", target: "submission/" })),
      pending,
    ),
    null,
  );
  // 就绪后两者都亮
  const done = ctx({ runStatus: "done" });
  assert.deepEqual(stepNodeAction(node("human", { key: "continue-notes" }), done), {
    kind: "continue-notes",
    enabled: true,
  });
  assert.deepEqual(stepNodeAction(node("human", { key: "endnote-export" }), done), {
    kind: "endnote-sync",
    enabled: true,
  });
});

test("EndNote 事项按标题也认得出来（模板可以改 key 但改不了标题含义）", () => {
  const h = humanState({ title: "把文献同步进 EndNote", timing: "after", optional: true });
  assert.deepEqual(stepNodeAction(humanNode(h), ctx({ runStatus: "review" })), {
    kind: "endnote-sync",
    enabled: false,
  });
});

test("域稿说明含 EndNote 也不挂文献库同步，审查条目不交文件", () => {
  const field = humanState({
    title: "打开 EndNote 域稿并 Update 一次",
    timing: "after",
    target: "",
  });
  // 域稿给「用 Word 打开」，不挂文献库同步三连（2026-10-24）
  assert.deepEqual(stepNodeAction(humanNode(field), ctx({ runStatus: "review" })), { kind: "open-field-docs" });
  const merged = humanState({ title: "在 Word 里换样式（打开域稿）", timing: "after", target: "" });
  assert.deepEqual(stepNodeAction(humanNode(merged), ctx({ runStatus: "done" })), { kind: "open-field-docs" });
  assert.equal(stepNodeAction(humanNode(merged, { done: true }), ctx({ runStatus: "done" })), null);
  const report = humanState({
    title: "逐条决定审查报告",
    timing: "after",
    target: "manuscript/review-report.md",
  });
  assert.equal(stepNodeAction(humanNode(report), ctx({ runStatus: "review" })), null);
});

test("AI 写好、人来填的清单：给「打开 / 交给 AI」，不给「提交产物」（2026-10-24）", () => {
  for (const [title, target] of [
    ["换原图与申请转载许可", "submission/figure-permissions.md"],
    ["填作者、单位与投稿声明", "submission/declarations.md"],
  ] as const) {
    const h = humanState({ title, timing: "after", target });
    assert.deepEqual(stepNodeAction(humanNode(h), ctx({ runStatus: "review" })), { kind: "edit-handback" }, title);
    assert.equal(stepNodeAction(humanNode(h, { done: true }), ctx({ runStatus: "review" })), null);
  }
  // 普通带落点的交付照旧
  const spec = humanState({ title: "放入学校格式规范", timing: "before", target: "docs/format/" });
  assert.deepEqual(stepNodeAction(humanNode(spec), ctx({ runStatus: "pending" })), { kind: "submit-deliverable" });
});

test("文献类交付：去「文献与数据」导入，按来源高亮", () => {
  const h = humanState({ title: "补充遗漏的文献", timing: "after", target: "papers/" });
  for (const [litSource, focus] of [
    ["zotero", "zotero"],
    ["endnote", "files"],
    ["folder", "files"],
    ["search", undefined],
    ["", undefined],
  ] as const) {
    assert.deepEqual(
      stepNodeAction(humanNode(h), ctx({ runStatus: "review", litSource })),
      { kind: "papers-import", focus, hasLibrary: focus !== undefined },
      `来源 ${litSource || "(空)"}`,
    );
  }
});

test("付费墙与待确认事项不给列表钮：它们的入口是行内清单展开", () => {
  for (const title of ["下载付费墙文献全文", "核对待确认篇目"]) {
    assert.equal(
      stepNodeAction(
        humanNode(humanState({ title, timing: "after", target: "papers/" })),
        ctx({ runStatus: "review" }),
      ),
      null,
      title,
    );
  }
});

test("已完成的事项不再给入口；after 未就绪同样不给", () => {
  const h = humanState({ title: "补充遗漏的文献", timing: "after", target: "papers/" });
  assert.equal(
    stepNodeAction(humanNode(h, { done: true }), ctx({ runStatus: "review" })),
    null,
  );
  // 同一件事，未就绪
  assert.equal(
    stepNodeAction(humanNode(h), ctx({ runStatus: "active", agentAttention: "working" })),
    null,
  );
});

test("非文献类交付保留直接提交；纯脑力事项（无落点）只能勾选", () => {
  const submit = humanState({ title: "填学校格式规范", target: "submission/spec.md" });
  assert.deepEqual(stepNodeAction(humanNode(submit), ctx()), {
    kind: "submit-deliverable",
  });
  // 已完成不再给提交钮
  assert.equal(
    stepNodeAction(humanNode(submit, { done: true }), ctx()),
    null,
  );
  // 无落点 = 纯脑力事项
  assert.equal(
    stepNodeAction(humanNode(humanState({ title: "想清楚研究问题" })), ctx()),
    null,
  );
  // 没有 human 的 human 节点（结构异常）不崩
  assert.equal(stepNodeAction(node("human", { key: "human:?" }), ctx()), null);
});

test("agent：「开始」始终可用，归档工作区换成「恢复工作区」", () => {
  // 未开工
  assert.deepEqual(stepNodeAction(node("agent"), ctx()), {
    kind: "start",
    readPaper: false,
    readPaperPrimary: false,
  });
  // 归档工作区：主入口换成恢复
  assert.deepEqual(stepNodeAction(node("agent"), ctx({ canRestore: true })), {
    kind: "restore-workspace",
  });
  // 示例课题精读步：另挂「开读这一篇」，开始降为次要
  assert.deepEqual(
    stepNodeAction(node("agent"), ctx({ readPaper: true, readPaperPrimary: true })),
    { kind: "start", readPaper: true, readPaperPrimary: true },
  );
  // 父级没传 onReadPaper：即使 readPaperPrimary 为真也不给开读钮
  assert.deepEqual(
    stepNodeAction(node("agent"), ctx({ readPaperPrimary: true })),
    { kind: "start", readPaper: false, readPaperPrimary: false },
  );
});

test("agent：进行中给「去终端看看」，会话跑完附完成提示", () => {
  assert.deepEqual(
    stepNodeAction(node("agent"), ctx({ runStatus: "active", agentAttention: "working" })),
    { kind: "go-terminal", agentDone: false },
  );
  assert.deepEqual(
    stepNodeAction(node("agent"), ctx({ runStatus: "active", agentAttention: "done" })),
    { kind: "go-terminal", agentDone: true },
  );
  // 待评审 / 已保存：动作交给评审节点，agent 行不再给钮
  assert.equal(stepNodeAction(node("agent"), ctx({ runStatus: "review" })), null);
  assert.equal(stepNodeAction(node("agent"), ctx({ runStatus: "done" })), null);
});

test("review：待评审必给，进行中只在 agent 出字/等确认时藏起来", () => {
  assert.deepEqual(stepNodeAction(node("review"), ctx({ runStatus: "review" })), {
    kind: "go-review",
    conflict: false,
  });
  assert.deepEqual(
    stepNodeAction(node("review"), ctx({ runStatus: "review", reviewConflict: true })),
    { kind: "go-review", conflict: true },
  );
  // 没工作区就没有评审入口
  assert.equal(
    stepNodeAction(node("review"), ctx({ runStatus: "review", hasWorkspace: false })),
    null,
  );
  // 进行中：agent 在出字/等确认时藏，收完这一轮（进程坐在提示符上）就给
  for (const attention of ["working", "confirm"] as const) {
    assert.equal(
      stepNodeAction(node("review"), ctx({ runStatus: "active", agentAttention: attention })),
      null,
      attention,
    );
  }
  assert.deepEqual(
    stepNodeAction(node("review"), ctx({ runStatus: "active", agentAttention: null })),
    { kind: "go-review", conflict: false },
  );
  // 未开工 / 已保存都没有评审动作
  assert.equal(stepNodeAction(node("review"), ctx({ runStatus: "pending" })), null);
  assert.equal(stepNodeAction(node("review"), ctx({ runStatus: "done" })), null);
});

test("讨论与输入节点不出动作", () => {
  for (const kind of ["discuss", "input"] as const) {
    assert.equal(stepNodeAction(node(kind), ctx({ runStatus: "review" })), null, kind);
  }
});

test("压暗的行里不会躺着可点的按钮", () => {
  // 两条口径（stepNodeWaiting / stepNodeAction）各写一遍，分叉就会出现「灰行里有活按钮」
  const titles = [
    "下载付费墙文献全文",
    "填学校格式规范",
    "同步到文献库",
    "核对待确认篇目",
  ];
  for (const title of titles) {
    for (const target of ["", "papers/", "submission/spec.md"]) {
      for (const status of ["pending", "active", "review", "done"] as const) {
        for (const attention of ["working", "confirm", "done", null] as const) {
          for (const expectedCount of [undefined, 5]) {
            const human = humanState({ title, timing: "after", target, expectedCount });
            const n = humanNode(human);
            const waiting = stepNodeWaiting(status, attention, human, false);
            if (!waiting) continue;
            assert.equal(
              stepNodeAction(n, ctx({ runStatus: status, agentAttention: attention })),
              null,
              `压暗却给了入口：${title} / ${target} / ${status} / ${attention} / ${expectedCount}`,
            );
          }
        }
      }
    }
  }
});

test("模板语料全覆盖：文献落点的事项落哪条分支与预期一致", () => {
  /**
   * 落点是 papers/ 的事项有三条出路，靠标题分流（这就是这三条判据存在的理由）：
   *   - 付费墙 / 待确认：入口是行内清单展开，不给列表钮；
   *   - EndNote 标题：给资料库同步三连。它们的**报告**落在 papers/ 下
   *     （如「决定 EndNote 同步项」落 papers/endnote-sync-report.md），
   *     但这件事本身是同步文献库，不是去导入——按落点分流会把它送到错的入口；
   *   - 其余：给「到「文献与数据」导入」。
   */
  const expectedKind = (title: string) => {
    if (title.includes("EndNote")) return "endnote-sync";
    if (
      title.includes("付费") ||
      (title.includes("待确认") && !/[「『\[【]待确认[」』\]】]/.test(title))
    ) {
      return null;
    }
    return "papers-import";
  };
  const counts: Record<string, number> = {};
  for (const tpl of PIPELINE_TEMPLATES) {
    for (const step of tpl.steps) {
      for (const task of (step.humanTasks ?? []) as HumanTaskDto[]) {
        if (!isPapersTarget(task.target)) continue;
        const want = expectedKind(task.title);
        counts[String(want)] = (counts[String(want)] ?? 0) + 1;
        // 就绪上下文（待评审）
        const human = humanState({
          title: task.title,
          target: task.target,
          timing: task.timing,
          optional: task.optional,
          done: false,
        });
        assert.equal(
          stepNodeAction(humanNode(human), ctx({ runStatus: "review" }))?.kind ?? null,
          want,
          `${tpl.id}/${task.title}`,
        );
      }
    }
  }
  // 内建模板里 papers/ 落点的事项只有两类：付费墙与 EndNote。第三类（导入入口）
  // 走的是用户自定义流水线——steps[].human_tasks 可由用户手写任意 title/target
  // （见 projects.rs 的 parse_config 往返），模板语料里没有样本，由上面的单元用例覆盖。
  assert.ok(counts["null"] > 0, "没有走行内清单分支的样本");
  assert.ok(counts["endnote-sync"] > 0, "没有走资料库同步分支的样本");
  assert.equal(
    counts["papers-import"] ?? 0,
    0,
    "内建模板出现了走导入分支的事项——说明新增了 papers/ 落点的普通事项，这条注释该更新",
  );
});
