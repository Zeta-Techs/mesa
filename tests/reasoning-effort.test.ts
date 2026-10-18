import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentEffort,
  detectEffortInOutput,
  detectModelInOutput,
  detectModelOnScreen,
  modelOnScreenSupported,
  modelReadbackSupported,
  outputTail,
  parseReasoningEffort,
  reasoningEffortValue,
} from "../src/reasoning-effort.ts";

test("单词旧值是单档", () => {
  assert.deepEqual(parseReasoningEffort("High"), {
    levels: ["high"],
    launch: "high",
  });
});

test("多选带开场默认", () => {
  assert.deepEqual(parseReasoningEffort("low,high,xhigh@high"), {
    levels: ["low", "high", "xhigh"],
    launch: "high",
  });
  assert.equal(reasoningEffortValue(["low", "high", "xhigh"], "high"), "low,high,xhigh@high");
});

test("斜杠串丢掉", () => {
  assert.deepEqual(parseReasoningEffort("hign/xhign"), { levels: [], launch: null });
  assert.equal(reasoningEffortValue([], null), null);
});

test("detectEffortInOutput：认 Claude Code 横幅 / 输入框右上 / /effort 回显，取最靠后一处", () => {
  assert.equal(detectEffortInOutput("glm-5.3 with xhigh effort · API Usage Billing", "claude-code"), "xhigh");
  assert.equal(
    detectEffortInOutput("\x1b[2m◉\x1b[22m\x1b[1Cxhigh\x1b[1C·\x1b[1C/effort"),
    "xhigh",
  );
  assert.equal(
    detectEffortInOutput("with xhigh effort ... ⎿  Set effort level to high"),
    "high",
  );
  assert.equal(detectEffortInOutput("◉ max · /effort"), "max");
  // 没有成句上下文的 effort 字样不算
  assert.equal(detectEffortInOutput("we need more effort here"), null);
  assert.equal(detectEffortInOutput("plain output"), null);
});

test("currentEffort：TUI 显示 > 本次覆盖 > 绑定开场档；都没有 = 不知道", () => {
  assert.equal(currentEffort({ seen: "xhigh", override: "low", launch: "max" }), "xhigh");
  assert.equal(currentEffort({ seen: null, override: " High ", launch: "max" }), "high");
  assert.equal(currentEffort({ launch: "max" }), "max");
  assert.equal(currentEffort({}), null);
  assert.equal(currentEffort({ seen: "bogus" }), null);
});

// 以下片段取自 2026-10-17 本机 PTY 实录（转义序列原样保留）
test("detectEffortInOutput：Codex 底栏逐段 CUP 定位，default = 没设档", () => {
  const def =
    "\x1b[39;3H\x1b[38;5;223;49mGPT-6-Astra default\x1b[39;23H\x1b[39;49m·\x1b[39;25H\x1b[38;5;151;49m~/ccode/scratch";
  assert.equal(detectEffortInOutput(def, "codex"), "default");
  const high =
    "\x1b[39;15H\x1b[22m\x1b[38;5;223;49mhigh\x1b[39;49m · \x1b[38;5;151;49m~/ccode/scratch\x1b[39m";
  assert.equal(detectEffortInOutput(def + high, "codex"), "high");
  assert.equal(currentEffort({ seen: "default", launch: "high" }), null);
  // 别家的形态不串用
  assert.equal(detectEffortInOutput(high, "claude-code"), null);
});

test("detectEffortInOutput：Grok 边框「模型 (档) · 权限」", () => {
  assert.equal(
    detectEffortInOutput("──── Zeta (high) · always-approve ─╯", "grok"),
    "high",
  );
});

test("detectEffortInOutput：Qwen /effort 回显三种句式", () => {
  assert.equal(
    detectEffortInOutput("Reasoning effort: xhigh (requested; the effective tier depends", "qwen"),
    "xhigh",
  );
  assert.equal(
    detectEffortInOutput("Reasoning effort set to low, but thinking is currently disabled", "qwen"),
    "low",
  );
  assert.equal(detectEffortInOutput("Current reasoning effort: max\nAvailable: low", "qwen"), "max");
});

test("detectEffortInOutput：Kimi 底栏 thinking = 开；没有规则的 CLI 不认", () => {
  assert.equal(
    detectEffortInOutput("\r\r\n Kimi K3 thinking  ~/ccode/scratch     ! to run", "kimi"),
    "on",
  );
  assert.equal(detectEffortInOutput("with high effort", "gemini"), null);
});

test("屏上读回模型：/model 回显与开场横幅（Claude Code 2.1.292 实录）", () => {
  assert.equal(
    detectModelInOutput(
      "⎿  Set model to `glm-5.2` and saved as your default for new sessions\x1b[2m\x1b[22m",
      "claude-code",
    ),
    "glm-5.2",
  );
  assert.equal(
    detectModelInOutput("Set model to `claude-opus-5-5[1m] (default)` and saved", "claude-code"),
    "claude-opus-5-5[1m]",
  );
  // 转圈行「thinking with high effort」与横幅同句式：不认，免得把 thinking 当模型名（2026-10-17 用户截图）
  assert.equal(detectModelInOutput("✻ thinking with high effort (esc to interrupt)", "claude-code"), null);
  assert.equal(detectModelInOutput(" glm-5.3 with xhigh effort · API Usage", "claude-code"), null);
  // 屏上渲染后没有反引号
  assert.equal(
    detectModelInOutput("  ⎿  Set model to glm-other and saved as your default for new sessions", "claude-code"),
    "glm-other",
  );
  // 同一帧里两次回显：取最靠后的
  assert.equal(
    detectModelInOutput("Set model to `glm-5.3` and saved\n Set model to `glm-5.2` and saved", "claude-code"),
    "glm-5.2",
  );
  assert.equal(detectModelInOutput("我们来聊聊 model 的选择", "claude-code"), null);
  assert.equal(detectModelInOutput("Set model to `x`", "codex"), null);
  // 2026-10-18 第三期：CodeBuddy 中途换不了，不读；Gemini 回显、Codex 底栏能读
  assert.equal(modelReadbackSupported("codebuddy"), false);
  assert.equal(modelReadbackSupported("codex"), true);
  assert.equal(detectModelInOutput("ℹ Model set to e2e-default", "gemini"), "e2e-default");
  assert.equal(detectModelInOutput("• Model changed to gpt-6.1-sol low", "codex"), "gpt-6.1-sol");
  // Codex 底栏只从画好的屏上读：差量重绘时输出流里档位前面是别的字（2026-10-18 用户截图「[14;5H好」）
  assert.equal(
    detectModelInOutput("  e2e-picked high · /private/var/folders/T/work\x1b[3;1H  gpt-5.5 xhigh · ~/code", "codex"),
    null,
  );
  assert.equal(detectModelInOutput("\x1b[14;5H好\x1b[38;3H high · ~/ccode/scratch", "codex"), null);
  assert.equal(detectModelInOutput("  GPT-6.1-Sol    Latest workhorse model for coding", "codex"), null);
});

test("Codex 底栏的模型从可视区读，取最下面那一行；不像模型名的不认", () => {
  assert.equal(modelOnScreenSupported("codex"), true);
  assert.equal(modelOnScreenSupported("claude-code"), false);
  const screen = [
    "  >_ OpenAI Codex (v0.163.0)",
    "› 你好",
    "• 你好！",
    "  old-model high · /tmp/x", // 对话记录里的旧底栏残影在上面
    "",
    "› Ask Codex to do anything",
    "",
    "  deepseek-v4-flash-0731 high · ~/ccode/scratch",
    "  ? for shortcuts",
  ];
  assert.equal(detectModelOnScreen(screen, "codex"), "deepseek-v4-flash-0731");
  assert.equal(detectModelOnScreen(["  e2e-picked default · /work"], "codex"), "e2e-picked");
  assert.equal(detectModelOnScreen(["  好 high · ~/ccode/scratch"], "codex"), null);
  assert.equal(detectModelOnScreen(["  [14;5H好 high · ~/ccode/scratch"], "codex"), null);
  assert.equal(detectModelOnScreen(screen, "claude-code"), null);
});

test("留给下一帧的尾巴不从转义序列中间开始", () => {
  assert.equal(outputTail("short", 160), "short");
  const text = "x".repeat(200) + "\x1b[14;5H好\x1b[38;3H high · ~/w";
  const cut = text.length - ("[14;5H好\x1b[38;3H high · ~/w".length);
  // 切口正好在 ESC 后面：残段「[14;5H好」丢掉，从下一个 ESC 开始
  const tail = outputTail(text, text.length - cut);
  assert.equal(tail.startsWith("\x1b[38;3H"), true);
  assert.equal(outputTail("a".repeat(300), 160), "");
});

test("Qwen Code 0.25.1 底栏写着当前思考档（/effort 之后屏上只剩一个空的 ●）", () => {
  assert.equal(detectEffortInOutput("  ➜ work · e2e-picked low", "qwen"), "low");
  assert.equal(detectEffortInOutput("  ➜ my-proj · glm-5.3 xhigh\n  ⏸ Ask permissions", "qwen"), "xhigh");
});
