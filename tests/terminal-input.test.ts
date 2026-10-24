import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeShellPath,
  joinDroppedPaths,
  dropHitsRect,
  firstImageItem,
  imageExtFromMime,
  pasteImageFeedback,
  shouldReportTerminalColors,
  xtermOscColorReport,
  KIMI_CSI_U_ENTER,
  KIMI_CSI_U_CTRL_V,
  ptyShiftEnterRewrite,
  macLineEditKey,
  armPrintableEcho,
  printableKeyFallback,
  takePrintableEcho,
  markdownToPlain,
} from "../src/terminal-input.ts";

test("escapeShellPath 安全字符路径原样返回", () => {
  assert.equal(escapeShellPath("/tmp/a.png"), "/tmp/a.png");
  // 非 ASCII（中文名）不在安全字符集内：保守包裹（各 shell 对单引号内 UTF-8 都安全）
  assert.equal(escapeShellPath("/Users/u/截图-1.png"), "'/Users/u/截图-1.png'");
});

test("escapeShellPath 含空格/引号/反斜杠整体单引号包裹", () => {
  assert.equal(escapeShellPath("/tmp/my pic.png"), "'/tmp/my pic.png'");
  assert.equal(escapeShellPath("C:\\Users\\a b\\x.png"), "'C:\\Users\\a b\\x.png'");
  assert.equal(escapeShellPath("it's.png"), "'it'\\''s.png'");
});

test("escapeShellPath Windows 分支：反斜杠是常规成分，只有空格才加双引号", () => {
  // 回归：POSIX 安全集不含 `\`，导致 Windows 上**每一条**绝对路径都被套引号，
  // 而 macOS 干净路径是裸写的 —— agent 收到的形态平白分叉。
  assert.equal(escapeShellPath("C:\\tmp\\a.png", true), "C:\\tmp\\a.png");
  // 含空格用双引号：PowerShell / cmd / agent TUI 都认，cmd 里单引号只是字面字符
  assert.equal(
    escapeShellPath("C:\\Users\\a b\\x.png", true),
    '"C:\\Users\\a b\\x.png"',
  );
  // 路径里的双引号自身双写
  assert.equal(escapeShellPath('C:\\a"b\\x.png', true), '"C:\\a""b\\x.png"');
});

test("joinDroppedPaths 多路径转义后空格拼接", () => {
  assert.equal(
    joinDroppedPaths(["/tmp/a.png", "/tmp/b c.png", "/tmp/d'e.txt"]),
    "/tmp/a.png '/tmp/b c.png' '/tmp/d'\\''e.txt'",
  );
  assert.equal(joinDroppedPaths([]), "");
  assert.equal(joinDroppedPaths(["/tmp/a.png", ""]), "/tmp/a.png");
});

test("dropHitsRect 物理像素与 CSS 像素都算命中", () => {
  const rect = { left: 10, top: 10, right: 110, bottom: 110 };
  assert.equal(dropHitsRect({ x: 50, y: 50 }, rect, 1), true);
  assert.equal(dropHitsRect({ x: 200, y: 200 }, rect, 1), false);
  // 2x 屏：报物理像素 100 = CSS 50
  assert.equal(dropHitsRect({ x: 100, y: 100 }, rect, 2), true);
});

test("kimi CSI-u 序列是 kitty 键盘协议的 Enter 与 Ctrl+V", () => {
  assert.equal(KIMI_CSI_U_ENTER, "\x1b[13u");
  assert.equal(KIMI_CSI_U_CTRL_V, "\x1b[118;5u");
});

test("复制文本去掉 Markdown 标记，代码和文件名还在", () => {
  const src = [
    "## 结论",
    "",
    "这是 **重点**，见 [论文](https://example.com) 和 `notes/a_b.md`。",
    "",
    "- 第一项",
    "1. 第二项",
    "",
    "```python",
    "print(1)",
    "```",
  ].join("\n");
  const plain = markdownToPlain(src);
  assert.equal(plain.includes("##"), false);
  assert.equal(plain.includes("**"), false);
  assert.equal(plain.includes("https://"), false);
  assert.match(plain, /这是 重点，见 论文 和 notes\/a_b.md。/);
  assert.match(plain, /^第一项$/m);
  assert.match(plain, /^第二项$/m);
  assert.match(plain, /^print\(1\)$/m);
  assert.equal(plain.includes("```"), false);
});

test("Shift+Enter 换行改写：codex/cursor 走 CSI-u，claude 走 ESC+CR，其它不改", () => {
  assert.equal(ptyShiftEnterRewrite("codex"), "\x1b[13;2u");
  assert.equal(ptyShiftEnterRewrite("cursor"), "\x1b[13;2u");
  // claude 官方 terminal-setup 给别家终端装的正是 ESC+CR；xterm 默认发 \r 会直接提交
  assert.equal(ptyShiftEnterRewrite("claude-code"), "\x1b\r");
  // Grok / CodeBuddy 不推 kitty，原先发 \r 把半截话发出去（2026-10-17 PTY 实测两家都认 ESC+CR）
  assert.equal(ptyShiftEnterRewrite("grok"), "\x1b\r");
  assert.equal(ptyShiftEnterRewrite("codebuddy"), "\x1b\r");
  assert.equal(ptyShiftEnterRewrite("kimi"), null);
  assert.equal(ptyShiftEnterRewrite("gemini"), null);
});

test("⌘← / ⌘→ / ⌘⌫ 照 iTerm 自然文本编辑改写成 Ctrl+A / E / U，kitty 推上来时用 CSI-u", () => {
  const k = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
  });
  assert.equal(macLineEditKey(k("ArrowLeft"), false), "\x01");
  assert.equal(macLineEditKey(k("ArrowRight"), false), "\x05");
  assert.equal(macLineEditKey(k("Backspace"), false), "\x15");
  assert.equal(macLineEditKey(k("ArrowLeft"), true), "\x1b[97;5u");
  assert.equal(macLineEditKey(k("Backspace"), true), "\x1b[117;5u");
  // ⌘⇧← 是选区、⌥← 是按词跳：不归这里
  assert.equal(macLineEditKey(k("ArrowLeft", { shiftKey: true }), false), null);
  assert.equal(macLineEditKey(k("ArrowLeft", { metaKey: false, altKey: true }), false), null);
  assert.equal(macLineEditKey(k("a"), false), null);
});

test("printableKeyFallback：keyCode 0 与 229 都当场补发", () => {
  const base = { type: "keydown", ctrlKey: false, altKey: false, metaKey: false };
  // WKWebView 上 Shift+/ 报 0：这一下 xterm 不发，宿主当场补
  assert.deepEqual(printableKeyFallback({ ...base, key: "?", keyCode: 0 }), {
    action: "send",
    data: "?",
  });
  // Shift+/ 实测报 229，且中文输入法下 key 可能不是 "?"。必须带物理键才补。
  assert.deepEqual(
    printableKeyFallback({ ...base, key: "?", code: "Slash", keyCode: 229, shiftKey: true }),
    { action: "send", data: "?" },
  );
  assert.equal(printableKeyFallback({ ...base, key: "?", keyCode: 229 }), null);
  // 中文上屏也是 229，且 key 就是那个字。补发会和输入法再写一次叠成「你你」。
  assert.equal(printableKeyFallback({ ...base, key: "你", keyCode: 229 }), null);
  assert.equal(printableKeyFallback({ ...base, key: "！", keyCode: 229 }), null);
  // 中文输入法开着：key 是 Process，物理键决定符号。
  assert.deepEqual(
    printableKeyFallback({
      ...base,
      key: "Process",
      code: "Slash",
      keyCode: 229,
      shiftKey: true,
    }),
    { action: "send", data: "?" },
  );
  assert.deepEqual(
    printableKeyFallback({
      ...base,
      key: "Process",
      code: "Digit1",
      keyCode: 229,
      shiftKey: true,
    }),
    { action: "send", data: "!" },
  );
  assert.deepEqual(
    printableKeyFallback({
      ...base,
      key: "Process",
      code: "Digit3",
      keyCode: 229,
      shiftKey: true,
    }),
    { action: "send", data: "#" },
  );
  // 正常 keyCode 的 Shift+3 由 xterm 发，宿主不补，避免变成两个。
  assert.equal(
    printableKeyFallback({
      ...base,
      key: "#",
      code: "Digit3",
      keyCode: 51,
      shiftKey: true,
    }),
    null,
  );
  assert.deepEqual(
    printableKeyFallback({
      ...base,
      key: "?",
      code: "Slash",
      keyCode: 229,
      shiftKey: true,
      isComposing: true,
    }),
    { action: "send", data: "?" },
  );
  // keyCode >= 48：xterm 自己会发（evaluateKeyboardEvent 认识 191:["/","?"]），不干预
  assert.equal(printableKeyFallback({ ...base, key: "?", keyCode: 191 }), null);
  assert.equal(printableKeyFallback({ ...base, key: "a", keyCode: 65 }), null);
});

test("补发回声按次数吞：连按两次只吞两次回声，第三次真输入留下", () => {
  const idle = { char: "", count: 0, until: 0 };
  const once = armPrintableEcho(idle, "#", 1000);
  assert.deepEqual(once, { char: "#", count: 1, until: 1400 });
  const twice = armPrintableEcho(once, "#", 1100);
  assert.equal(twice.count, 2);
  const first = takePrintableEcho(twice, "#", 1200);
  assert.equal(first.swallow, true);
  assert.equal(first.guard.count, 1);
  const second = takePrintableEcho(first.guard, "#", 1250);
  assert.equal(second.swallow, true);
  assert.equal(second.guard.count, 0);
  const third = takePrintableEcho(second.guard, "#", 1300);
  assert.equal(third.swallow, false);
  const other = takePrintableEcho(once, "!", 1100);
  assert.equal(other.swallow, false);
  assert.equal(other.guard.count, 1);
});

test("printableKeyFallback：修饰键、具名键、控制字符、keyup 一律不补", () => {
  const base = { type: "keydown", key: "?", keyCode: 0, ctrlKey: false, altKey: false, metaKey: false };
  // 带修饰键的不是可打印字符，是终端控制序列
  assert.equal(printableKeyFallback({ ...base, ctrlKey: true }), null);
  assert.equal(printableKeyFallback({ ...base, altKey: true }), null);
  assert.equal(printableKeyFallback({ ...base, metaKey: true }), null);
  // 具名键（key 是长名）不该被当成单字符补发
  assert.equal(printableKeyFallback({ ...base, key: "Enter" }), null);
  assert.equal(printableKeyFallback({ ...base, key: "ArrowUp" }), null);
  assert.equal(printableKeyFallback({ ...base, key: "Shift" }), null);
  // 控制字符走各自通道
  assert.equal(printableKeyFallback({ ...base, key: "\r", keyCode: 0 }), null);
  assert.equal(printableKeyFallback({ ...base, key: "\x7f", keyCode: 0 }), null);
  // keyup 与同一次按键共用 handler，只认 keydown
  assert.equal(printableKeyFallback({ ...base, type: "keyup" }), null);
  assert.equal(printableKeyFallback({ ...base, type: "keypress" }), null);
});

test("firstImageItem 挑出第一个 image/* 条目", () => {
  assert.equal(
    firstImageItem([{ type: "text/plain" }, { type: "image/png" }]),
    1,
  );
  assert.equal(firstImageItem([{ type: "text/plain" }]), -1);
  assert.equal(
    firstImageItem([{ type: "image/png" }, { type: "image/jpeg" }]),
    0,
  );
});

test("imageExtFromMime 白名单映射与兜底 png", () => {
  assert.equal(imageExtFromMime("image/png"), "png");
  assert.equal(imageExtFromMime("image/jpeg"), "jpg");
  assert.equal(imageExtFromMime("image/gif"), "gif");
  assert.equal(imageExtFromMime("image/webp"), "webp");
  assert.equal(imageExtFromMime("image/bmp"), "png");
  assert.equal(imageExtFromMime("IMAGE/JPEG"), "jpg");
});

test("pasteImageFeedback 长文件名截断", () => {
  assert.equal(
    pasteImageFeedback("/cfg/ccode/tmp/paste-20260817-110000-ab12.png"),
    "已粘贴图片路径：paste-20260817-110000-ab12.png",
  );
  const long = `/tmp/${"x".repeat(60)}.png`;
  const out = pasteImageFeedback(long);
  assert.ok(out.startsWith("已粘贴图片路径："), out);
  assert.ok(out.endsWith("…"), out);
});

test("xtermOscColorReport 生成 Agent TUI 可识别的 16-bit RGB 回报", () => {
  // 每个 8-bit 通道复制一份成 16-bit：gemini 的 OSC_11_REGEX 与 codex 的探测都按这个格式解析
  assert.equal(
    xtermOscColorReport(11, "#fdfdfe"),
    "\x1b]11;rgb:fdfd/fdfd/fefe\x1b\\",
  );
  assert.equal(
    xtermOscColorReport(10, "#3a3f52"),
    "\x1b]10;rgb:3a3a/3f3f/5252\x1b\\",
  );
  assert.equal(
    xtermOscColorReport(11, " #FFFFFF "),
    "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
  );
  // 非 #rrggbb（如 transparent / rgba）没法回报，返回 null 由调用方跳过
  assert.equal(xtermOscColorReport(11, "transparent"), null);
});

const reportOpts = (over: Partial<Parameters<typeof shouldReportTerminalColors>[0]> = {}) => ({
  isWindows: true,
  kind: "agent" as const,
  agentId: "gemini",
  themeId: "midnight-light",
  enabled: true,
  ...over,
});

test("底色告知只在 Windows + 探测型 agent + 浅色 + 开关开启时发生", () => {
  assert.equal(shouldReportTerminalColors(reportOpts()), true);
  // macOS/Linux 的 xterm.js 会如实应答 OSC 查询，不需要主动推
  assert.equal(shouldReportTerminalColors(reportOpts({ isWindows: false })), false);
  // 普通 shell 不探测底色，推了只会变成输入框里的乱码
  assert.equal(shouldReportTerminalColors(reportOpts({ kind: "shell" })), false);
  // 深色本就是 agent 探测失败的回落值，推了没收益
  assert.equal(shouldReportTerminalColors(reportOpts({ themeId: "midnight" })), false);
  assert.equal(shouldReportTerminalColors(reportOpts({ themeId: undefined })), false);
  assert.equal(shouldReportTerminalColors(reportOpts({ enabled: false })), false);
});

test("只推给会消费 OSC 10/11 回报的 agent，其余一律不推", () => {
  // 实测会探测并消费：gemini（TerminalCapabilityManager）、qwen（detectOsc11Theme）、
  // codex 0.162（terminal_identity.rs 重新引入探测；0.150 曾短暂移除）
  for (const id of ["gemini", "qwen", "codex"]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ agentId: id })), true, id);
  }
  // claude-code 走 settings.json theme、不探测；其余各家未观察到探测消费
  for (const id of ["claude-code", "cursor", "kimi", "opencode", "codebuddy", "grok"]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ agentId: id })), false, id);
  }
  assert.equal(shouldReportTerminalColors(reportOpts({ agentId: undefined })), false);
});

test("七套浅色主题都会触发底色告知", () => {
  for (const id of [
    "midnight-light",
    "terracotta-light",
    "ayu-light",
    "mocha-light",
    "neutral-light",
    "dracula-light",
    "shadcn-light",
  ]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ themeId: id })), true, id);
  }
});
