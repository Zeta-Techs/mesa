import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_EMAIL,
  FEEDBACK_KINDS,
  FEEDBACK_TEMPLATES,
  WEBMAIL_TARGETS,
  feedbackKindLabel,
  feedbackEnvLine,
  feedbackSubject,
  feedbackBody,
  feedbackImageNote,
  feedbackMailto,
  feedbackPayload,
  mailtoTooLong,
  stripUnfilledTemplate,
} from "../src/feedback.ts";

test("类型闭集四档，标签与引导语齐备", () => {
  assert.deepEqual(
    FEEDBACK_KINDS.map((k) => k.id),
    ["feature", "bug", "question", "other"],
  );
  for (const k of FEEDBACK_KINDS) {
    assert.ok(k.label && k.label.length >= 2, `${k.id} 缺标签`);
    assert.ok(k.hint && k.hint.length >= 4, `${k.id} 缺引导语`);
  }
  assert.equal(feedbackKindLabel("feature"), "功能需求");
  assert.equal(feedbackKindLabel("nope" as never), "其他");
});

test("环境行：分段拼接、macOS arm 标 Apple 芯片、缺段跳过", () => {
  assert.equal(
    feedbackEnvLine({ version: "0.1.0", os: "macos", arch: "aarch64", channel: "release" }),
    "Mesa v0.1.0 · macOS · Apple 芯片",
  );
  assert.equal(
    feedbackEnvLine({ os: "windows", arch: "x86_64" }),
    "Windows · x64",
  );
  assert.equal(
    feedbackEnvLine({ version: "0.2.0", os: "macos", arch: "x86_64", channel: "dev" }),
    "Mesa v0.2.0 · macOS · x64 · 开发模式",
  );
  assert.equal(feedbackEnvLine({}), "");
});

test("类型脚手架：缺陷/功能需求有模板；空模板行发送时剔除、填了的保留", () => {
  assert.ok(FEEDBACK_TEMPLATES.bug!.includes("做了什么："));
  assert.ok(FEEDBACK_TEMPLATES.bug!.includes("预期："));
  assert.ok(FEEDBACK_TEMPLATES.feature!.startsWith("想解决的问题："));
  assert.equal(FEEDBACK_TEMPLATES.question, undefined);
  // 整份模板原样 → 剔除后为空（前端据此判「未填」）
  assert.equal(stripUnfilledTemplate(FEEDBACK_TEMPLATES.bug!), "");
  // 填了内容的行保留，没填的整行剔除；缩进/尾随空格容忍
  const filled = "做了什么：点了导出\n预期：出文件\n实际：   \n自由一行";
  assert.equal(
    stripUnfilledTemplate(filled),
    "做了什么：点了导出\n预期：出文件\n自由一行",
  );
  // 正文构造走同一条剔除
  const body = feedbackBody({
    kind: "bug",
    title: "t",
    detail: "做了什么：点了导出\n预期：\n实际：报错",
  });
  assert.ok(body.includes("做了什么：点了导出"));
  assert.ok(body.includes("实际：报错"));
  assert.ok(!body.includes("预期："));
});

test("主题带类型前缀，正文结构：详情 + 可选联系方式 + 环境/错误日志段", () => {
  assert.equal(feedbackSubject("feature", "  文献雷达导出  "), "[Mesa·功能需求] 文献雷达导出");
  const body = feedbackBody({
    kind: "bug",
    title: "x",
    detail: "点了没反应",
    contact: "a@b.c",
    envLine: "Mesa v0.1.0 · macOS · Apple 芯片",
    errorLog: "2026-10-12 17:00 [runs] 启动失败",
  });
  assert.ok(body.startsWith("点了没反应"));
  assert.ok(body.includes("联系方式：a@b.c"));
  assert.ok(body.includes("——以下由 Mesa 自动附带——"));
  assert.ok(body.includes("最近错误日志："));
  assert.ok(body.includes("2026-10-12 17:00 [runs] 启动失败"));
  // 不填联系方式 / 不带环境与日志：不出现空段
  const bare = feedbackBody({ kind: "question", title: "x", detail: "怎么导出？" });
  assert.equal(bare, "怎么导出？");
});

test("mailto 通道：收件人预填、主题正文编码、超长保护阈值", () => {
  const url = feedbackMailto("[Mesa·缺陷] 崩溃", "步骤一\n步骤二");
  assert.ok(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`), url);
  assert.ok(url.includes(encodeURIComponent("[Mesa·缺陷] 崩溃")));
  assert.ok(url.includes(encodeURIComponent("步骤一\n步骤二")));
  assert.ok(!mailtoTooLong(url));
  assert.ok(mailtoTooLong(`mailto:${FEEDBACK_EMAIL}?body=${"x".repeat(2000)}`));
});

test("网页邮箱：Gmail/Outlook 带参深链；QQ/163 无公开带参方案只开首页", () => {
  const gmail = WEBMAIL_TARGETS.find((t) => t.id === "gmail")!;
  const url = gmail.composeUrl("a@b.c", "主题", "正文");
  assert.ok(gmail.carriesBody);
  assert.ok(url.includes("view=cm"), url);
  assert.ok(url.includes(encodeURIComponent("a@b.c")));
  assert.ok(url.includes(encodeURIComponent("主题")));
  // QQ：cgi-bin/compose 已 404（2026-10-12 实证），不得再生成带参链接
  for (const id of ["qq", "163"]) {
    const t = WEBMAIL_TARGETS.find((x) => x.id === id)!;
    assert.ok(!t.carriesBody, id);
    assert.ok(!t.composeUrl("a@b.c", "s", "b").includes("compose"), id);
    assert.ok(t.composeUrl("a@b.c", "s", "b").startsWith("https://mail."), id);
  }
});

test("端点负载：与后端 FeedbackPayloadDto 同构、空缺字段归 null、正文去空白", () => {
  const p = feedbackPayload({
    kind: "feature",
    title: "  文献雷达导出 ",
    detail: "希望可以导出 ",
    contact: "  ",
    env: { version: "0.1.0", os: "macos", arch: "aarch64" },
  });
  assert.deepEqual(p, {
    app: "mesa",
    kind: "feature",
    title: "文献雷达导出",
    detail: "希望可以导出",
    contact: null,
    env: { version: "0.1.0", os: "macos", arch: "aarch64", channel: null },
  });
  const bare = feedbackPayload({ kind: "bug", title: "t", detail: "d" });
  assert.deepEqual(bare.env, { version: null, os: null, arch: null, channel: null });
  assert.equal(bare.app, "mesa");
});

test("截图附件：随负载带上（有则序列化、无则不落字段）；邮件通道注记成句", () => {
  const withImg = feedbackPayload({
    kind: "bug",
    title: "t",
    detail: "d",
    images: [{ name: "屏 1.png", mime: "image/png", data: "aGk=" }],
  });
  assert.deepEqual(withImg.images, [{ name: "屏 1.png", mime: "image/png", data: "aGk=" }]);
  assert.ok(!("images" in feedbackPayload({ kind: "bug", title: "t", detail: "d" })));
  const note = feedbackImageNote("/Users/x/Downloads/ccode-exports/mesa-feedback-x", 2);
  assert.ok(note.includes("2 张截图"));
  assert.ok(note.includes("mesa-feedback-x"));
  assert.ok(note.includes("添加为附件"));
});
