import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSessionLabel,
  replaceAbsFsPaths,
  sessionIsInterrupted,
  splitRecentItems,
  tidySessionText,
  tidySessionTitle,
  unwrapPromptTags,
} from "../src/session-title.ts";

test("自定义标题原样保留，不清洗", () => {
  assert.deepEqual(
    tidySessionTitle({
      customTitle: "方向拍板",
      title: "https://example.com/foo 我要重做导航",
    }),
    { title: "方向拍板", interrupted: false, unnamed: false },
  );
});

test("去掉 URL 与客套前缀，截到之后之前", () => {
  assert.equal(
    tidySessionText(
      "https://app.zeta.top/ 我要对这个网页进行重新设计 之后还要合并到项目中去",
    ),
    "对这个网页进行重新设计",
  );
});

test("中断提示不当标题，记 interrupted", () => {
  assert.equal(sessionIsInterrupted("[Request interrupted by user]"), true);
  assert.deepEqual(
    tidySessionTitle({ customTitle: null, title: "[Request interrupted by user]" }),
    { title: "未命名对话", interrupted: true, unnamed: true },
  );
});

test("CLI resume 与未命名回落", () => {
  assert.equal(
    tidySessionText("claude --resume 96c38b13-d700-4a86-a44e-007bbf21c1a3"),
    null,
  );
  assert.deepEqual(
    tidySessionTitle({
      customTitle: null,
      title: "未命名对话 · session_",
    }),
    { title: "未命名对话", interrupted: false, unnamed: true },
  );
  assert.deepEqual(
    tidySessionTitle({
      customTitle: null,
      title: "未命名对话 · 019fa1b7",
    }),
    { title: "未命名对话", interrupted: false, unnamed: true },
  );
});

test("已短的标题不动；空格后的正事也留下", () => {
  assert.equal(tidySessionText("优化 AI 工作台导航页"), "优化 AI 工作台导航页");
  assert.equal(
    tidySessionText("熟悉一下该程序 我要对该程序进行设计优化"),
    "熟悉一下该程序 我要对该程序进行设计优化",
  );
});

test("展示标题去掉 markdown 装饰，不把符号当主题", () => {
  assert.equal(tidySessionText("# 当 Agent 越来越强"), "当 Agent 越来越强");
  assert.equal(tidySessionText("**修好登录**"), "修好登录");
  assert.equal(tidySessionText("用 `git status` 看改动"), "用 git status 看改动");
  assert.equal(
    tidySessionText("审计报告 **审计结论: B 级"),
    "审计报告 审计结论: B 级",
  );
});

test("剥掉 user_query 标签，标题留完整句子", () => {
  assert.equal(unwrapPromptTags("<user_query>\n你好\n</user_query>"), "你好");
  assert.equal(
    tidySessionText("<user_query>\n把文献综述的第二章压缩到 800 字\n</user_query>"),
    "把文献综述的第二章压缩到 800 字",
  );
});

test("标题全是噪声时用摘要顶上", () => {
  assert.deepEqual(
    tidySessionTitle({
      customTitle: null,
      title: "https://example.com/a",
      summary: "网页美观度对标顶尖AI网站",
    }),
    { title: "网页美观度对标顶尖AI网站", interrupted: false, unnamed: false },
  );
});

test("绝对路径换成文件名，相对路径不动", () => {
  assert.equal(
    replaceAbsFsPaths("请看这份文件：/Users/me/AI4Paper/AI4Paper.md"),
    "请看这份文件：AI4Paper.md",
  );
  assert.equal(
    replaceAbsFsPaths('请看这份文件："/Users/me/My File.md"'),
    "请看这份文件：My File.md",
  );
  assert.equal(replaceAbsFsPaths("改 src/app.tsx"), "改 src/app.tsx");
  assert.equal(replaceAbsFsPaths("notes/课题A/01.md"), "notes/课题A/01.md");
  assert.equal(
    replaceAbsFsPaths("请看这份文件：C:\\Users\\a\\b.xlsx"),
    "请看这份文件：b.xlsx",
  );
  assert.equal(
    tidySessionText("请看这份文件：/Users/example/Documents/AI4Paper/AI4Paper.md"),
    "看这份文件：AI4Paper.md",
  );
  assert.equal(tidySessionText("Fix the nav. Then merge it"), "Fix the nav");
});

test("项目侧栏未命名写成对话，旧的收在更早", () => {
  assert.equal(
    projectSessionLabel({ title: "未命名对话", interrupted: false, unnamed: true }),
    "对话",
  );
  assert.equal(
    projectSessionLabel({ title: "综述角度", interrupted: false, unnamed: false }),
    "综述角度",
  );
  assert.deepEqual(splitRecentItems([1, 2, 3], 8), { recent: [1, 2, 3], older: [] });
  assert.deepEqual(splitRecentItems([1, 2, 3, 4], 3), {
    recent: [1, 2, 3],
    older: [4],
  });
});
