import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_TEMPLATE,
  composeLaunchPrompt,
  defaultContextRules,
  effectiveProjectRules,
  formatTopLevelMap,
  isGoalContextPack,
  isSessionTemplateKey,
  isSettingPlaceholder,
  normalizeSessionInjectionMode,
  projectHomeHint,
  projectShowsProtectedPaths,
  projectUsesSkillPool,
  renderProjectContextPack,
  renderSessionInjection,
  splitLaunchPrompt,
} from "../src/project-context.ts";

test("research pack names the project, lists files, and states write-review", () => {
  const pack = renderProjectContextPack({
    name: "AI Agent 研究",
    path: "/Users/me/AI Agent 研究",
    workMode: "research",
    topic: "Agent 在软件工程中的应用",
    settings: ["引用必须可追溯"],
    topLevel: [
      { name: "papers", isDir: true },
      { name: "notes", isDir: true },
      { name: "README.md", isDir: false },
      { name: ".git", isDir: true },
    ],
    goal: "根据项目里的文献写综述",
    writeReview: true,
  });
  assert.match(pack, /AI Agent 研究/);
  assert.match(pack, /科研/);
  assert.match(pack, /papers\//);
  assert.doesNotMatch(pack, /\.git/);
  assert.match(pack, /课题主题/);
  assert.match(pack, /工作环境/);
  assert.match(pack, /按项目里已有的材料做/);
  assert.match(pack, /根据项目里的文献写综述/);
  assert.match(pack, /验收再写回/);
});

test("pack lists accepted goals and previous review notes", () => {
  const pack = renderProjectContextPack({
    name: "AI Agent 研究",
    path: "/p",
    workMode: "research",
    topLevel: [{ name: "papers", isDir: true }],
    goal: "补 Agentic Coding",
    accepted: [
      { name: "研究综述", outputs: ["论文/综述.md"] },
      "数据清洗",
    ],
    openGoals: ["设计实验"],
    protectedPaths: ["数据/raw"],
    feedback: "引用太少",
    writeReview: true,
  });
  assert.match(pack, /已经验收过/);
  assert.match(pack, /研究综述 → 论文\/综述.md（已接受）/);
  assert.match(pack, /尚未完成/);
  assert.match(pack, /设计实验/);
  assert.match(pack, /写回时跳过/);
  assert.match(pack, /数据\/raw/);
  assert.match(pack, /上一版的修改意见/);
  assert.match(pack, /引用太少/);
});

test("owned rules replace defaults instead of stacking them", () => {
  assert.match(
    effectiveProjectRules(["目标读者：专家"], "research", false).join("\n"),
    /不要改用户没让动的文件/,
  );
  assert.deepEqual(effectiveProjectRules(["只写中文"], "research", true), ["只写中文"]);
});

test("empty template forms are not rules", () => {
  assert.equal(
    isSettingPlaceholder("综述角度：（领域全景 / 聚焦某个子问题）"),
    true,
  );
  assert.equal(isSettingPlaceholder("优先使用项目里已有的文件。"), false);
  assert.equal(isSettingPlaceholder("综述角度：聚焦子问题"), false);
});

test("unanswered forms do not enter TASK.md rules", () => {
  const lines = effectiveProjectRules(
    [
      "综述角度：（领域全景 / 聚焦某个子问题）",
      "答辩时间：（倒推各章节的截止）",
      "数据敏感级别：（含个人信息 / 已脱敏 / 公开数据）",
    ],
    "research",
    false,
  );
  assert.deepEqual(lines, defaultContextRules("research"));
  assert.doesNotMatch(lines.join("\n"), /答辩时间/);
  assert.doesNotMatch(lines.join("\n"), /虚构文献/);
});

test("pipeline rules replace work-mode defaults instead of stacking every template", () => {
  const lines = effectiveProjectRules(
    [
      "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
      "引用必须能追溯到项目中的来源。",
      "综述角度：聚焦某个子问题",
      "查重目标：（如 ≤10%）",
    ],
    "research",
    false,
  );
  assert.deepEqual(lines, [
    "优先使用项目里已有的 papers/、notes/ 和 references.bib，不要虚构文献。",
    "引用必须能追溯到项目中的来源。",
    "综述角度：聚焦某个子问题",
  ]);
});

test("non-pipeline research rules do not assume a literature review", () => {
  const lines = defaultContextRules("research");
  assert.deepEqual(lines, [
    "优先使用项目里已有的文件。",
    "不要改用户没让动的文件。",
  ]);
});

test("formatTopLevelMap caps long lists and marks empty trees", () => {
  assert.deepEqual(formatTopLevelMap([]), ["- （顶层还没有文件）"]);
  const many = Array.from({ length: 30 }, (_, index) => ({
    name: `f${index}`,
    isDir: false,
  }));
  const lines = formatTopLevelMap(many, 24);
  assert.equal(lines.length, 25);
  assert.match(lines[24], /还有 6 项/);
});

test("composeLaunchPrompt keeps pack and user text apart", () => {
  assert.equal(composeLaunchPrompt("PACK", ""), "PACK");
  assert.equal(composeLaunchPrompt("", "hello"), "hello");
  assert.equal(composeLaunchPrompt("PACK", "hello"), "PACK\n\n----\n\nhello");
});

test("pack splits named goal skills from project skill pool", () => {
  const pack = renderProjectContextPack({
    name: "数据分析",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
    skills: [
      {
        name: "data-clean",
        description: "数据清洗规范",
        digest: "a1b2c3d4e5f6",
        inputs: ["data/"],
        outputs: ["artifacts/"],
        named: true,
      },
      { name: "lit-search", digest: "ff00ff00", named: false },
      { name: "ghost-skill", missing: true, named: false },
    ],
  });
  assert.match(pack, /本目标点名要用的技能（按其规范执行/);
  assert.match(pack, /data-clean（版本 a1b2c3d4）：数据清洗规范（读取 data\/；产出 artifacts\/）/);
  assert.match(pack, /项目技能池（可用工具，列出 ≠ 要用；本目标没点名的默认不用）/);
  assert.match(pack, /ghost-skill（未安装，可在技能页新建或导入）/);
  // 纪律线：只有点名的才执行
  assert.match(pack, /只有「本目标点名要用的技能」才按其规范执行/);
});

test("research pipeline does not use the project skill pool", () => {
  assert.equal(projectUsesSkillPool("research", 0), true);
  assert.equal(projectUsesSkillPool("research", 3), false);
  assert.equal(projectUsesSkillPool(undefined, 2), false);
  assert.equal(projectUsesSkillPool("office", 4), true);
  assert.equal(projectUsesSkillPool("coding", 0), true);
});

test("protected paths stay on goal-review surfaces only", () => {
  assert.equal(projectShowsProtectedPaths("research", 0), true);
  assert.equal(projectShowsProtectedPaths("research", 3), false);
  assert.equal(projectShowsProtectedPaths("office", 0), true);
  assert.equal(projectShowsProtectedPaths("coding", 0), false);
});

test("pack always carries skill discipline line against over-engineering", () => {
  const pack = renderProjectContextPack({
    name: "p",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
  });
  // 没选技能也要有纪律线：技能分发在 CLI 全局目录，Agent 看得见
  assert.match(pack, /技能纪律：只做目标要求的事/);
  assert.match(pack, /不要自行引入额外流程、模板或重型技能/);
});

test("session pack follows the user instead of a goal brief", () => {
  const pack = renderProjectContextPack({
    name: "综述文献",
    path: "/Users/me/综述文献",
    workMode: "research",
    settings: ["优先使用项目里已有的文件，不要虚构文献。"],
    topLevel: [
      { name: "manuscript", isDir: true },
      { name: "notes", isDir: true },
    ],
    kind: "session",
    goal: "写一篇综述",
    openGoals: ["补实验设计"],
    protectedPaths: ["数据/raw"],
    skills: [{ name: "lit-search", named: false }],
    feedback: "引用太少",
    accepted: [{ name: "研究综述", outputs: ["论文/综述.md"] }],
  });
  assert.match(pack, /综述文献/);
  assert.match(pack, /这是项目里的对话/);
  assert.match(pack, /按用户这次说的做/);
  assert.match(pack, /技能纪律：按用户这次说的做/);
  assert.match(pack, /已经验收过/);
  assert.doesNotMatch(pack, /产出经人验收后才进项目/);
  assert.doesNotMatch(pack, /当前目标/);
  assert.doesNotMatch(pack, /尚未完成/);
  assert.doesNotMatch(pack, /写回时跳过/);
  assert.doesNotMatch(pack, /本目标点名/);
  assert.doesNotMatch(pack, /项目技能池/);
  assert.doesNotMatch(pack, /上一版的修改意见/);
  assert.doesNotMatch(pack, /只做目标要求的事/);
});

test("writeReview session still uses the goal pack", () => {
  const pack = renderProjectContextPack({
    name: "p",
    path: "/tmp/p",
    workMode: "research",
    topLevel: [],
    kind: "session",
    writeReview: true,
    goal: "落成稿",
  });
  assert.match(pack, /产出经人验收后才进项目/);
  assert.match(pack, /当前目标：/);
  assert.match(pack, /验收再写回/);
  assert.equal(isGoalContextPack("session", true), true);
  assert.equal(isGoalContextPack("session"), false);
  assert.equal(isGoalContextPack("goal"), true);
  assert.equal(isGoalContextPack(), true);
});

test("coding rules warn against writing the primary tree", () => {
  assert.match(defaultContextRules("coding").join("\n"), /主仓/);
  assert.match(projectHomeHint("office").join("\n"), /文档风格/);
});

// ===== 对话注入三态（2026-10-16 拍板）=====

test("injection mode garbage falls back to auto", () => {
  assert.equal(normalizeSessionInjectionMode(null), "auto");
  assert.equal(normalizeSessionInjectionMode(undefined), "auto");
  assert.equal(normalizeSessionInjectionMode("loud"), "auto");
  assert.equal(normalizeSessionInjectionMode("custom"), "custom");
  assert.equal(normalizeSessionInjectionMode("off"), "off");
});

const FULL_SESSION_INPUT = {
  name: "综述流程测试",
  path: "/Users/me/综述流程测试",
  workMode: "research",
  topic: "镁硫电池",
  settings: ["优先使用项目里已有的 papers/，不要虚构文献。"],
  topLevel: [
    { name: "papers", isDir: true },
    { name: "notes", isDir: true },
  ],
  kind: "session" as const,
  decisions: ["综述角度聚焦负极"],
  memory: "只用项目内文献。",
  accepted: [{ name: "文献检索", outputs: ["papers/included.md"] }],
};

test("default template renders byte-identical to the auto session pack", () => {
  // 单一代码路径的回归守卫：默认模板 = 自动包版式
  assert.equal(
    renderSessionInjection(DEFAULT_SESSION_TEMPLATE, FULL_SESSION_INPUT),
    renderProjectContextPack(FULL_SESSION_INPUT),
  );
  // 稀疏输入：空段消隐后相邻段仍恰好隔一空行，不多出空行
  const sparse = {
    name: "空项目",
    path: "/tmp/empty",
    workMode: "research",
    topLevel: [],
    kind: "session" as const,
  };
  assert.equal(
    renderSessionInjection(DEFAULT_SESSION_TEMPLATE, sparse),
    renderProjectContextPack(sparse),
  );
});

test("custom template fills placeholders and collapses empty sections", () => {
  const rendered = renderSessionInjection(
    "{{课题主题}}\n\n{{项目规则}}\n\n回答先给结论。",
    FULL_SESSION_INPUT,
  );
  assert.match(rendered, /^课题主题：\n镁硫电池/);
  assert.match(rendered, /项目规则：\n1\. 优先使用项目里已有的/);
  assert.match(rendered, /回答先给结论。$/);
  // 有内容的相邻段之间恰好一个空行（空段不留多余空行）
  assert.doesNotMatch(rendered, /\n{3,}/);
  // 空段整段省略：没有 settings 时项目规则段不出现
  const noRules = renderSessionInjection(
    "A\n\n{{项目规则}}\n\nB",
    { ...FULL_SESSION_INPUT, settings: [] },
  );
  assert.equal(noRules, "A\n\nB");
});

test("custom template keeps unknown placeholders verbatim", () => {
  const rendered = renderSessionInjection(
    "你好 {{不存在的段}} {{课题主题}}",
    FULL_SESSION_INPUT,
  );
  assert.match(rendered, /\{\{不存在的段\}\}/);
  assert.match(rendered, /课题主题：/);
});

test("prototype-chain names are not placeholders", () => {
  // {{constructor}}/{{__proto__}} 一类若直接查普通对象会拿到原生函数/对象，
  // 必须按清单判、原样保留（2026-10-16 审查实证过的坑）
  const rendered = renderSessionInjection(
    "A {{constructor}} B {{__proto__}} C {{toString}} D",
    FULL_SESSION_INPUT,
  );
  assert.equal(
    rendered,
    "A {{constructor}} B {{__proto__}} C {{toString}} D",
  );
  assert.doesNotMatch(rendered, /native code/);
  assert.equal(isSessionTemplateKey("constructor"), false);
  assert.equal(isSessionTemplateKey("项目名"), true);
});

test("spaced placeholders share one criterion between renderer and panel", () => {
  // 渲染端键先 trim：{{ 项目名 }} 是已知占位符、会被替换；
  // 面板点名「未识别」必须同一判据，不能整串精确匹配
  const rendered = renderSessionInjection(
    "A {{ 项目名 }} B",
    FULL_SESSION_INPUT,
  );
  assert.equal(rendered, "A 综述流程测试 B");
  assert.equal(isSessionTemplateKey(tokenInner("{{ 项目名 }}")), true);
  assert.equal(isSessionTemplateKey(tokenInner("{{ 真未知 }}")), false);
});

function tokenInner(token: string): string {
  return token.slice(2, -2);
}

test("equivalence holds for regular data; block-internal blank-line runs are custom-mode collapsed", () => {
  // 等价性的已知边界：段内容自带连续空行（如 memory 条目间空两行）时，
  // auto 包原样保留、custom 渲染统一折叠为一段空行——排版级差异、预览可见，
  // 在此钉住语义，防止被当成等价性破绽误修
  const airy = { ...FULL_SESSION_INPUT, memory: "第一条结论。\n\n\n\n第二条结论。" };
  const auto = renderProjectContextPack(airy);
  assert.match(auto, /第一条结论。\n\n\n\n第二条结论。/);
  const custom = renderSessionInjection(DEFAULT_SESSION_TEMPLATE, airy);
  assert.match(custom, /第一条结论。\n\n第二条结论。/);
});

test("memory cap applies inside the placeholder block", () => {
  const long = "x".repeat(6100);
  const rendered = renderSessionInjection("{{长期知识}}", {
    ...FULL_SESSION_INPUT,
    memory: long,
  });
  assert.match(rendered, /已按最新有效知识优先/);
  assert.ok(rendered.length < 6200);
});

test("第一句里的项目说明和人说的话分开：气泡与取回只认人说的", () => {
  const pack = "你正在项目「测试项目」中工作。\n工作方式：科研";
  assert.deepEqual(splitLaunchPrompt(composeLaunchPrompt(pack, "帮我整理文献")), {
    pack,
    said: "帮我整理文献",
  });
  // 只发了包（以前项目 ＋ 新对话自己开跑的那种）
  assert.deepEqual(splitLaunchPrompt(pack), { pack, said: "" });
  // Windows 换行
  assert.equal(splitLaunchPrompt(`${pack}\r\n\r\n----\r\n\r\n你好`).said, "你好");
  // 不是 Mesa 的包头：原样当人话，哪怕里面有分隔线
  assert.deepEqual(splitLaunchPrompt("第一段\n\n----\n\n第二段"), {
    pack: null,
    said: "第一段\n\n----\n\n第二段",
  });
});
