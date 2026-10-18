/** 网关思考档：逗号多选，`@` 后是开场默认。单词旧值视为只开这一档。 */

const KNOWN = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
  "on",
  "off",
]);

export function parseReasoningEffort(raw: string | null | undefined): {
  levels: string[];
  launch: string | null;
} {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { levels: [], launch: null };
  const at = trimmed.lastIndexOf("@");
  const list = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const marked = at >= 0 ? trimmed.slice(at + 1).trim().toLowerCase() : null;
  const levels: string[] = [];
  for (const part of list.split(",")) {
    const level = part.trim().toLowerCase();
    if (!KNOWN.has(level) || levels.includes(level)) continue;
    levels.push(level);
  }
  if (!levels.length) return { levels: [], launch: null };
  const launch = marked && levels.includes(marked) ? marked : levels[0];
  return { levels, launch };
}

export function reasoningEffortValue(levels: string[], launch: string | null): string | null {
  const unique = levels.filter((level, index) => KNOWN.has(level) && levels.indexOf(level) === index);
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0];
  const start = launch && unique.includes(launch) ? launch : unique[0];
  return `${unique.join(",")}@${start}`;
}

/** CLI 屏上明确写着「没设档 / 用默认」时的认出值（Codex 底栏「<模型> default · 目录」）。 */
export const EFFORT_SEEN_DEFAULT = "default";

/** 状态栏「当前思考档」：TUI 自己画出来的档位（最可信，含人在终端里敲的 /effort）
 *  > 本次开工弹层覆盖 > 绑定逐模型策略的开场档；都没有 = 不知道，状态栏不得冒充某一档。
 *  屏上明写 default 时就是「用默认」，不再回落到注入值（注入没生效时它才是真相）。 */
export function currentEffort(input: {
  seen?: string | null;
  override?: string | null;
  launch?: string | null;
}): string | null {
  if (input.seen?.trim().toLowerCase() === EFFORT_SEEN_DEFAULT) return null;
  for (const raw of [input.seen, input.override, input.launch]) {
    const level = raw?.trim().toLowerCase() ?? "";
    if (level && KNOWN.has(level)) return level;
  }
  return null;
}

// ANSI：CSI / OSC / 单字符转义。TUI 每帧都在重画，先剥掉再认字。
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// TUI 常用「光标右移 N 格」「光标定位到 行;列」代替空格（Codex 底栏实测逐段 CUP 定位），
// 先换成空格再剥其余转义，免得词粘在一起
// eslint-disable-next-line no-control-regex
const CURSOR_GAP_RE = /\x1b\[\d*C|\x1b\[\d*;\d*[Hf]/g;
const LEVEL = "(none|minimal|low|medium|high|xhigh|ultra|max)";
/** 目录开头：Codex/Kimi 底栏档位后面紧跟工作目录 */
const PATH_HEAD = String.raw`(?:~|/|[A-Za-z]:[\\/])`;

/**
 * 各家屏上写档位的成句形态（2026-10-17 本机 PTY 实录 + 包内字符串）。只认带固定上下文的形态，
 * 回答正文里聊到 effort / high 之类的字样不算。认出值取这段文字里最靠后的一处。
 * - Claude Code 2.1.x：横幅「glm-5.3 with xhigh effort」、输入框右上「◉ xhigh · /effort」、
 *   /effort 回显「Set effort level to high」
 * - Codex 0.163：底栏「GPT-6-Astra high · ~/目录」，没设档写「default」
 * - Grok Build 1.0.x：输入框边框「Zeta (high) · always-approve」
 * - Qwen Code 0.25：/effort 回显「Reasoning effort: high (requested…」「Reasoning effort set to high, but…」
 *   「Current reasoning effort: high」（中文界面这几句也不翻译）；0.25.1 起底栏「➜ 目录 · 模型 档位」也写档
 *   （2026-10-18 第三期实录：/effort low 后屏上只剩一个空的「●」，档位只在底栏变）
 * - Kimi Code 2.1：底栏「Kimi K3 thinking  ~/目录」= 开（Mesa 对 Kimi 只给 on/off 两档）
 */
const EFFORT_PATTERNS: Record<string, RegExp[]> = {
  "claude-code": [
    new RegExp(String.raw`\bwith\s+${LEVEL}\s+effort\b`, "gi"),
    new RegExp(String.raw`\b${LEVEL}\s*·\s*/effort\b`, "gi"),
    new RegExp(String.raw`\beffort\s+level\s+to\s+${LEVEL}\b`, "gi"),
  ],
  codex: [new RegExp(String.raw`\b(none|minimal|low|medium|high|xhigh|default)\s*·\s*${PATH_HEAD}`, "gi")],
  grok: [new RegExp(String.raw`\(${LEVEL}\)\s*·`, "gi")],
  qwen: [
    new RegExp(String.raw`➜\s+\S+\s+·\s+\S+\s+${LEVEL}\b`, "gi"),
    new RegExp(String.raw`\bReasoning effort:\s+${LEVEL}\b`, "gi"),
    new RegExp(String.raw`\bReasoning effort set to\s+${LEVEL}\b`, "gi"),
    new RegExp(String.raw`\bCurrent reasoning effort:\s+${LEVEL}\b`, "gi"),
  ],
  kimi: [new RegExp(String.raw`\b(thinking)\s+${PATH_HEAD}`, "gi")],
};
// CodeBuddy 是 Claude Code 的 fork，横幅/回显同形
EFFORT_PATTERNS.codebuddy = EFFORT_PATTERNS["claude-code"]!;

/** 每家要先看见的关键词：一帧里没有就不跑正则（每帧都调，保持便宜） */
const QUICK_KEYS: Record<string, string[]> = {
  "claude-code": ["effort"],
  codebuddy: ["effort"],
  codex: ["·"],
  grok: [")"],
  qwen: ["effort", "➜"],
  kimi: ["thinking"],
};

/**
 * 从终端输出里认 CLI 当前显示的思考档。认不出返回 null；Codex 明写 default 时返回
 * {@link EFFORT_SEEN_DEFAULT}；Kimi 底栏写 thinking 时返回 "on"。
 * 输出按帧到达、句子可能被切开：调用方把上一帧尾巴（tail）拼在前面再传进来。
 */
export function detectEffortInOutput(text: string, agentId = "claude-code"): string | null {
  const patterns = EFFORT_PATTERNS[agentId];
  if (!patterns) return null;
  if (!(QUICK_KEYS[agentId] ?? []).some((key) => text.includes(key))) return null;
  const plain = text.replace(CURSOR_GAP_RE, " ").replace(ANSI_RE, "");
  let best: { at: number; level: string } | null = null;
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) {
      const at = m.index ?? 0;
      if (!best || at >= best.at) best = { at, level: m[1]!.toLowerCase() };
    }
  }
  if (!best) return null;
  return best.level === "thinking" ? "on" : best.level;
}

/**
 * 屏上读回当前模型（2026-10-17 用户：切完模型芯片显示的是 Mesa 以为的，不是 CLI 实际的）。
 * Claude Code 2.1.292 认 /model 回显「Set model to glm-5.2 and saved…」；2026-10-18 第三期补两家：
 * Gemini 0.64「ℹ Model set to e2e-default」、Codex 0.163 选择器回显「Model changed to …」。
 * Codex 底栏「模型 档位 · 目录」只能从画好的屏上读（{@link detectModelOnScreen}）：它差量重绘，只重画变了的格子，
 * 输出流里档位前面不一定是模型名（2026-10-18 用户截图：芯片显示「[14;5H好」——输入框回显「你好」的光标定位 + 字）。
 * CodeBuddy 中途换不了（/model 只认它自家的模型），不再读。
 * 不认「X with high effort」：思考中的转圈行也是这个句式（「thinking with high effort」），
 * 曾把 thinking 当成模型名显示在芯片上（2026-10-17 用户截图）。别家暂无可靠形态 → 返回 null，芯片照实标「已发送」。
 * 读到的名字去掉尾巴「 (default)」；「[1m]」这类上下文后缀原样保留（那是 CLI 自己的模型名写法）。
 */
const MODEL_PATTERNS: Record<string, RegExp[]> = {
  "claude-code": [
    // 屏上是渲染后的 Markdown，反引号没了：「⎿  Set model to glm-other and saved…」；会话文件里才带反引号
    /\bSet model to\s+`?([^\s`]+)/g,
  ],
  gemini: [/\bModel set to\s+`?([^\s`]+)/g],
  // 选择器选完的回显「• Model changed to gpt-6.1-sol low」（底栏写的是显示名 GPT-6.1-Sol，回显才是 id）
  codex: [/\bModel changed to\s+([^\s]+)/g],
};
/** 每家要先看见的关键词（每帧都调，保持便宜） */
const MODEL_QUICK: Record<string, string[]> = {
  "claude-code": ["Set model"],
  gemini: ["Model set"],
  codex: ["Model changed"],
};

/** 像个模型名：可见 ASCII、不以转义残段「[」开头。挡住切帧切出来的「[14;5H好」、输入框里的字 */
function plausibleModel(name: string): boolean {
  return /^[A-Za-z0-9][\x21-\x7e]*$/.test(name);
}

export function detectModelInOutput(text: string, agentId = "claude-code"): string | null {
  const patterns = MODEL_PATTERNS[agentId];
  if (!patterns) return null;
  if (!(MODEL_QUICK[agentId] ?? []).some((key) => text.includes(key))) return null;
  const plain = text.replace(CURSOR_GAP_RE, " ").replace(ANSI_RE, "");
  let best: { at: number; model: string } | null = null;
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) {
      const at = m.index ?? 0;
      const model = m[1]!.replace(/\s*\(default\)\s*$/i, "").trim();
      if (plausibleModel(model) && (!best || at >= best.at)) best = { at, model };
    }
  }
  return best?.model ?? null;
}

/** 底栏整行写着当前模型的家：从可视区（xterm 已画好的行）读，不从输出流读 */
const MODEL_SCREEN_PATTERNS: Record<string, RegExp> = {
  // Codex 0.163 底栏「  e2e-picked high · /目录」，没设档写「default」
  codex: new RegExp(
    String.raw`^\s*([^\s·]+)\s+(?:none|minimal|low|medium|high|xhigh|default)\s*·\s*${PATH_HEAD}`,
  ),
};

export function modelOnScreenSupported(agentId: string): boolean {
  return agentId in MODEL_SCREEN_PATTERNS;
}

/** 从可视区读底栏上的模型：自下往上找第一行（底栏在对话记录下面） */
export function detectModelOnScreen(lines: string[], agentId: string): string | null {
  const re = MODEL_SCREEN_PATTERNS[agentId];
  if (!re) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!);
    if (m && plausibleModel(m[1]!)) return m[1]!;
  }
  return null;
}

/**
 * 认档 / 认模型时留给下一帧拼接的尾巴：只留最后 max 个字符。切口落在转义序列中间（ESC 被切在前面）时，
 * 丢掉第一个 ESC / 空白之前的残段，免得「[14;5H」这类残渣当正文读
 */
export function outputTail(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  // eslint-disable-next-line no-control-regex
  const at = cut.search(/[\x1b\s]/);
  return at < 0 ? "" : cut.slice(at);
}

/** 这家 CLI 有没有可靠的模型回显：没有时切换后芯片只能写「已发送」 */
export function modelReadbackSupported(agentId: string): boolean {
  return agentId in MODEL_PATTERNS;
}
