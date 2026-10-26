/**
 * 聊天层「正在生成」时的实时预览：从终端画面读出 AI 正在写的那段回复（纯逻辑，读 xterm 可视区文本行）。
 *
 * 为什么要它：聊天层按会话文件同步，各家一段正文写完才落盘；终端里是逐字 / 逐行的。
 * 原先只给「看实时输出」把终端拉出来，用户的感受是「终端比聊天层先显示」（2026-10-17）。
 * 现在把终端里已经出来、聊天层还没有的那几行直接画在聊天层的生成提示上方，会话文件追上后自动让位。
 *
 * 每家一张「画面布局」（2026-10-17 Claude Code 实录；2026-10-18 第三期假 API + PTY 逐家抓屏补上五家，
 * 样本在 tests/live-reply.test.ts）。共同的读法：找到输入框（之上才是对话区）→ 最后一条用户回显之后是这一轮 →
 * 助手段落的行首符号去掉、续行去掉缩进 → 工具调用、转圈、用时、提示行不进预览。
 *   Claude Code 2.1.x：「❯ 回显 / ⏺ 正文（续行缩进 2）/ Read 1 file / ✻ 转圈 / ─── ❯ ───」
 *   Codex 0.163：     「› 回显 / • 正文（续行缩进 2）/ • Ran … / • Working (… esc to interrupt) / › 输入行」（无边框）
 *   Qwen Code 0.25：  「  > 回显 / ◆ 正文（续行缩进 4–5）/   ? Shell … / ⠼ … esc to cancel / ─── >  ───」
 *   Gemini CLI 0.64： 「▄▄ > 回显 ▀▀ / ✦ 正文（续行缩进 2–3）/ Thinking... (esc to cancel) / ▄▄ > 输入 ▀▀」
 *   Grok Build 1.0：  「❯ 回显（缩进 5，右侧时间）/ ┃ ◆ Thinking… 思考框 / 正文无行首符号（缩进 5）/ ◆ Running … / ⠧ Responding… / ╭ │ ❯ │ ╰」
 *   Kimi Code 2.2：   「❯ 回显 / ● 正文（续行缩进 3）/ ● Running a command … / ⠏ Working… / ╭ │ > │ ╰」
 * 认不出的：CodeBuddy 2.168 生成中只画「✹ Waking… (streaming · ↓ N tokens)」，正文写完才一次画出，屏上没有可读的半截；
 * OpenCode 1.19 是整屏重绘的分栏界面，对话区不按行排。这两家返回 null，聊天层退回「看实时输出」入口。
 */

interface Layout {
  /** 输入框顶在第几行（之上是对话区）；-1 = 不在对话界面（信任菜单、登录页、全屏选择器） */
  boxTop(rows: readonly string[]): number;
  /** 用户输入的回显（这一轮从它下一行开始） */
  echo: RegExp;
  /** 助手一段的行首（匹配到的部分去掉）；Grok 没有，用 null */
  lead: RegExp | null;
  /** 工具调用那一行（它和它的续行都不进预览） */
  tool: RegExp;
  /** 转圈、用时、提示、装饰行 */
  skip: RegExp;
  /**
   * 这种行折行时，续行（比正文缩进深、不带符号）也跳过，到空行或下一段为止。Claude 转圈下面的「⎿  Tip: …」
   * 长过一行时，第二行「     it with "use at most 5 agents", …」原先被当成回复，一直挂在预览里（2026-10-20 用户 Windows 实测，
   * Claude Code 2.1.304；终端窄一点 Mac 上同样会折行）
   */
  wrapSkip?: RegExp;
  /**
   * 思考框的头一行：它和下面行首是「│」的行整块不进回复预览，另由 {@link extractLiveThinking} 读出、照原样（去掉竖线与头一行）显示在聊天层。
   * Grok 1.0.70 思考时画「┃  ◆ Thinking…」（简化字形下是「│  ♦」：pywinpty 抓屏是这套，Mesa 终端里是前一套，2026-10-26 实录），
   * 下面竖线框里滚动显示思考原文（开头折成「┃  …」），想完收成一行
   * 「♦ Thought for 8.6s」（2026-10-26 用户 Windows 截图：思考原文连竖线一起当成了回复）
   */
  thinkBlock?: RegExp;
  /**
   * 思考框头一行下面算作框里的行，匹配到的部分去掉（不写 = 行首竖线 ┃ / │，Grok）。
   * Kimi 2.3 没有竖线：「⠋ thinking…」下面缩进两格的两行是思考原文的最后两行，到空行为止
   */
  thinkGutter?: RegExp;
  /**
   * 斜体的行是思考原文（调用方按屏上的字样告诉哪几行是斜体）。Kimi 想完把思考收成「● 第一行 / 续行 / … (N more lines…)」，
   * 行首的 ● 和回复正文一模一样，只差在思考整段是斜体浅字——不认，回复一出来，上面收起的思考就当成回复的开头一起显示
   */
  thinkItalic?: boolean;
  /** 续行去掉的缩进（空格数，最多去这么多） */
  indent: number;
  /** 行尾要去掉的东西（Grok 右侧的时间） */
  tail?: RegExp;
  /**
   * 回复长过一屏后，这家把提问钉在屏幕第一行（Codex 0.163：「› 提问」顶格、多行提问拼成一行，
   * 下一行直接接回复中段，2026-10-19 抓屏）。第一行的回显就不一定是这一轮的开头
   */
  pinnedEcho?: boolean;
  /**
   * 回显下面（隔着空行）紧跟这一行 = 回复开头已经卷上去了，回显是钉在屏顶的提问（Grok 1.0：长过一屏后提问钉住、
   * 下面一行居中的「▲」，2026-10-22 抓屏）。这时屏上只是一截，要接到上一次后面
   */
  scrolledHint?: RegExp;
  /**
   * 顶格的圆角框（╭ … ╰）是这家的提示框，不是回复（Qwen 的「Qwen Code update available!」画在输入框上面，
   * 原先整段当成回复贴在预览末尾，2026-10-22 金丝雀抓屏）。表格用的是方角（┌），不受影响
   */
  noticeBox?: boolean;
  /**
   * 输入框正上方有这一行 = 这家自己的对话区被往上翻了，屏上是翻上去的旧内容，不是这一轮。Codex 0.164 起对话区能滚，
   * 翻上去时输入框上方出「↓ Back to bottom · esc」（2026-10-26 用户 Windows 截图：预览里是前两轮的回复，连这行提示一起）
   */
  scrolledAway?: RegExp;
}

// 思考框左边那条竖线（Grok：Mesa 终端里是粗线 ┃，简化字形下是 │）
const THINK_GUTTER = /^\s*[│┃]/;
// 横线、半格边框，以及方框的上下边（画到一半的输入框「╭────」也算）
const BORDER = /^[╭╰]?[─━═▄▀]{8,}[╮╯]?$/;
const MENU_BORDER = /^[▔▁]{8,}$/;
const SPINNER = /^\s*[\u2800-\u28ff]\s/;
// Claude：转圈 / 用时 / 右对齐的思考档提示：✻ Sautéed for 7s · done、✶ Thinking…、● high · /effort；
// 还有两种界面提示，聊天层里按不了、也不是回复：「Thought for 7s (ctrl+o to expand)」（思考折叠行，不带行首符号，
// 会被当成上一段的续行）和任何「(ctrl+o to expand)」「(ctrl+r to …)」这类快捷键提示（2026-10-19 用户截图）
// ● 只在缩进行里算状态（右对齐的「● high · /effort」）：顶格的 ● 是 Windows 上 Claude 的正文行首
const CLAUDE_STATUS =
  /^\s*(?:[✻✶✳✢✽✺∴*·◈]\s|Thought for \d|.*·\s*\/effort\s*$)|^\s+●\s|\(ctrl\+[a-z] to [^)]*\)\s*$/;
// Claude 2.1.x 把工具调用折成一行摘要：Read 1 file、Ran 2 commands、Searched for 3 patterns…
const TOOL_SUMMARY =
  /^\s*(?:Read|Ran|Searched|Listed|Wrote|Edited|Updated|Fetched|Called|Created|Deleted|Found)\b.*\b(?:files?|commands?|patterns?|director(?:y|ies)|lines?|tools?|pages?|results?)\b/;
const TOOL_VERB =
  "(?:Ran|Running|Explored|Exploring|Edited|Editing|Read|Reading|Wrote|Writing|Searched|Searching|Listed|Updated|Called|Calling|Waited|Waiting|Added|Deleted|Applied|Applying|Fetched|Fetching|Used|Using)";

/** 最后一个满足 pick 的行号，返回 map 给出的输入框顶 */
function lastBox(rows: readonly string[], pick: (i: number) => number): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const top = pick(i);
    if (top >= 0) return top;
  }
  return -1;
}

const LAYOUTS: Record<string, Layout> = {
  "claude-code": {
    // 输入框上边框：最后一条「❯」行的上一行是横线
    boxTop: (rows) => lastBox(rows, (i) => (i > 0 && /^❯/.test(rows[i]) && BORDER.test(rows[i - 1].trim()) ? i - 1 : -1)),
    echo: /^❯\s+\S/,
    // 行首符号：macOS / Linux 是 ⏺，Windows 上 Claude Code 画 ●（控制台字体没有 ⏺，2026-10-20 ConPTY 抓屏）
    lead: /^[⏺●]\s?/,
    // 工具名可以是两个词：「Web Search(…)」「Notebook Edit(…)」（旧写法 [A-Za-z]* 漏掉带空格的，整行被当成正文）；
    // 括号必须紧跟字母，「⏺ Note (important)…」这种正文不会误判
    tool: new RegExp(`^[⏺●]\\s+[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*\\(|${TOOL_SUMMARY.source}`),
    skip: CLAUDE_STATUS,
    wrapSkip: /^\s*⎿/,
    indent: 2,
  },
  codex: {
    // 没有边框：最后一条「›」行就是输入行（占位字「Ask Codex to do anything」或草稿）
    boxTop: (rows) => lastBox(rows, (i) => (/^›(?:\s|$)/.test(rows[i]) ? i : -1)),
    // 斜杠命令回显成顶格的「/status」（不带 ›），后面是它的结果块
    echo: /^(?:›\s+\S|\/[a-z][\w-]*(?:\s|$))/,
    lead: /^•\s/,
    // 失败的命令写成「• Failed (exit 6) curl …」；审批结果「✔ You approved codex to run … / this time」不带 • 也不是回复，
    // 当工具行连同续行一起跳过（2026-10-19 用户截图：这两种行混进预览，预览从它们起整段重贴）
    tool: new RegExp(`^•\\s+(?:${TOOL_VERB}|Failed)\\b|^[✔✓✗✘■]\\s+You\\s`),
    skip: /^•\s+Working\b|esc to interrupt|^\s*(?:─+\s*)?Worked for\b|^\s*└/,
    indent: 2,
    pinnedEcho: true,
    // 0.164 tui/src/transcript_view/composer_gap.rs 的几种写法：「↓ Back to bottom · esc」「↓ Bottom」「New activity · ↓ …」
    scrolledAway: /^(?:↓\s*)?(?:New activity(?:\s+·\s+)?)?(?:↓(?:\s+(?:Back to bottom|Bottom))?(?:\s+·\s+esc)?)?$/,
  },
  qwen: {
    boxTop: (rows) => lastBox(rows, (i) => (i > 0 && /^>\s/.test(rows[i]) && BORDER.test(rows[i - 1].trim()) ? i - 1 : -1)),
    echo: /^\s{1,3}>\s+\S/,
    lead: /^\s*◆\s/,
    // 「  ? Shell echo …」「  - Shell …」「  ✓ ReadFile …」：顶两格 + 状态符号 + 工具名（正文列表缩进更深）
    tool: /^ {2}[?✓✔✗✘⊷○◐-]\s+[A-Z]/,
    // 思考折叠行「∴ Thought for 1s (click or ctrl+o to expand)」（模型带思考时才有，2026-10-21 用户截图）
    skip: /esc to cancel|^\s*●\s*$|Waiting for user confirmation|^\s*∴\s|\((?:click or )?ctrl\+o to expand\)/,
    noticeBox: true,
    // 段落续行缩进 4、列表 / 代码行缩进 5：最多去 5 格，两种都对齐到行首
    indent: 5,
  },
  gemini: {
    // 输入框与回显都包在 ▄▄▄ / ▀▀▀ 半格边框里：最后一个才是输入框。输入框行首按状态换字：平时「>」、完全访问（YOLO）「*」、
    // shell 模式「!」、翻历史「(r:)」（Gemini 0.65 InputPrompt）；原先只认「>」，完全访问时整轮认不出输入框、预览不出（2026-10-22 抓屏）
    boxTop: (rows) =>
      lastBox(rows, (i) =>
        i > 0 && /^\s?(?:[>*!]|\(r:\))\s/.test(rows[i]) && /^▄{8,}$/.test(rows[i - 1].trim()) ? i - 1 : -1,
      ),
    echo: /^\s?>\s+\S/,
    lead: /^✦\s/,
    tool: /^\s*[╭│╰]/,
    // 输入框上方的提示与状态行。0.65 起按权限档变字（「auto-accept edits  Shift+Tab to manual」），MCP 后面还跟技能数
    // （「1 MCP server · 20 skills」）；粘贴多行后回显下面多一行「Press Ctrl+O to expand pasted text」（2026-10-21 用户截图）；
    // 完全访问时是「YOLO Ctrl+Y」，没有 MCP 时这一行只有它（2026-10-22）
    skip: /esc to cancel|Shift\+Tab to |auto-accept edits|^\s*YOLO\b.*Ctrl\+Y|\? for shortcuts|\bMCP servers?\b|\b\d+ skills?\s*$|Press Ctrl\+O to expand|^\s*[╭│╰]/,
    // 段落续行缩进 2、列表缩进 3
    indent: 3,
  },
  grok: {
    // Windows 上 Grok 换了一套字形（2026-10-20 ConPTY 抓屏）：回显与输入框 ❯ → >，工具 ◆ → ♦，代码块标签 ◇ → ○
    boxTop: (rows) =>
      lastBox(rows, (i) => (/^\s*╭[─━]+╮$/.test(rows[i]) && /^\s*│\s*[❯>]/.test(rows[i + 1] ?? "") ? i : -1)),
    echo: /^\s+[❯>]\s+\S/,
    lead: null,
    tool: /^\s*[◆♦]\s/,
    // ▲ / ▼ = 对话区上下还有内容的滚动提示（提问钉在屏顶时紧跟在它下面）；
    // 转圈行「| Waiting for response… 0.0s」「- Thinking… 3.8s」「\ Responding… 2.2s」：Windows 上转圈是 | / - \，
    // 不归 SPINNER 管；按 Ctrl+C 后输入框上方的「Press Ctrl+c to cancel the turn」（2026-10-26 抓屏）
    skip: /Responding…|^\s*\S\s+[A-Z][\w ]*…\s+[\d.]+s\b|Press Ctrl\+c to cancel the turn|^\s*Worked for\b|^\s*[◇○]\s+\S+\s+\[Copy\]$|^\s*[▲▼]$/,
    thinkBlock: /^\s*[│┃]\s*[◆♦]\s/,
    indent: 5,
    tail: /\s{2,}\d{1,2}:\d{2}\s?[AP]M$/,
    scrolledHint: /^\s*▲$/,
  },
  kimi: {
    boxTop: (rows) =>
      lastBox(rows, (i) => (/^\s*╭[─━]+╮$/.test(rows[i]) && /^\s*│\s*>/.test(rows[i + 1] ?? "") ? i : -1)),
    echo: /^\s*❯\s+\S/,
    lead: /^\s*●\s/,
    tool: new RegExp(`^\\s*[●✗✓•]\\s+${TOOL_VERB}\\b`),
    // 2.3 等首字时转月相「🌑 · Tip: …」（2026-10-21 抓屏；用户截图里 🌕Kimi 叠在「正在回复」上面）。
    // MCP 服务连上 / 失败 / 要登录时插进对话区的状态行「MCP server "x" needs OAuth — run /mcp-config login x」
    // （2.3.2 McpStatus finalizeMcpServerStatusRow；2026-10-26 用户 Windows 截图：接在回复后面成了正文）
    // 收起的思考下面那行「… (12 more lines, ctrl+o to expand)」也不是回复
    skip: /Press Ctrl\+B to run in background|^\s*Tool ".*" was not run|^\s*Rejected:|^\s*[\u{1F311}-\u{1F318}]|^\s*·\s*Tip:|^\s*MCP server ".+?" (?:connected\b|failed\b|needs OAuth\b|disabled$|removed$|connecting…)|^\s*… \(\d+ more lines?, ctrl\+o to expand\)/u,
    // 思考中（2.3.2 ThinkingComponent live）：「⠋ thinking…」下面缩进两格、只留思考原文的最后两行；想完收成斜体的「● …」一段
    thinkBlock: /^\s*[⠀-⣿]\s+thinking…\s*$/,
    thinkGutter: /^(?=\s{2,}\S)/,
    thinkItalic: true,
    indent: 3,
  },
};

/**
 * Claude Code 转圈行里这一轮已生成的 token 数：「✶ Musing… (5s · ↓ 1.2k tokens)」→ 1200。
 * Windows 上 Claude Code 整条消息收完才画出来（2026-10-21 抓屏：2.1.292 / 2.1.305 都是转圈计数、最后一次画出；
 * 2026-10-26 查 2.1.310 二进制：Windows 版把「生成中文字可见」的平台判断编译成常量假，无开关可开，见 architecture §10 2026-10-21「Windows 上 Claude 回复不流式」条），
 * 聊天层没有逐字预览，拿它告诉人还在出字；长思考时也有用。只认 ↓（收到的），认不出返回 null
 */
export function claudeOutputTokens(lines: readonly string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /…\s*\([^)]*↓\s*([\d.]+)\s*(k)?\s*tokens?\b/i.exec(lines[i]);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return Math.round(n * (m[2] ? 1000 : 1));
    }
  }
  return null;
}

export function liveReplySupported(agentId: string): boolean {
  return agentId in LAYOUTS;
}

/**
 * Claude Code 这一轮还在跑：输入框下面的提示行带「esc to interrupt」（2.1.310 抓屏：「⏸ manual mode on · esc to interrupt」，
 * 按 Esc 打断后只剩「⏸ manual mode on」）。打断后看屏确认回合真停了再收旁路的回合（TerminalPage settleAfterEsc）
 */
export function claudeTurnActiveOnScreen(lines: readonly string[]): boolean {
  return lines.some((l) => /\besc to interrupt\b/i.test(l));
}

/**
 * 屏上正在想的那一框（Layout.thinkBlock：Grok、Kimi）：这一轮回显之后、输入框之上，头一行下面算作框里的几行（Layout.thinkGutter），
 * 照终端原样给聊天层显示（2026-10-26 用户：就要原生的思考显示，只把竖条、Thinking 符号这些无关的去掉）——去掉竖线与共同缩进、
 * 头一行「◆ Thinking…」「⠋ thinking…」、CLI 把前面折掉时的「…」一行，终端按框宽折的行接回成段。想完收起、确认菜单挂着、不在对话界面时返回 null
 */
export function extractLiveThinking(lines: readonly string[], agentId: string): string[] | null {
  const layout = LAYOUTS[agentId];
  const head = layout?.thinkBlock;
  if (!head) return null;
  const gutter = layout.thinkGutter ?? THINK_GUTTER;
  const rows = cleanRows(lines);
  if (rows.some((l) => MENU_BORDER.test(l.trim()))) return null;
  const boxTop = layout.boxTop(rows);
  if (boxTop < 0) return null;
  let at = -1;
  for (let i = boxTop - 1; i >= 0; i--) {
    if (head.test(rows[i])) {
      at = i;
      break;
    }
    if (layout.echo.test(rows[i])) return null;
  }
  if (at < 0) return null;
  const body: string[] = [];
  for (let i = at + 1; i < boxTop && gutter.test(rows[i]); i++) {
    const text = rows[i].replace(gutter, "");
    if (text.trim() !== "…") body.push(text);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const out = body.map((l) => (l.trim() ? l.slice(indent) : ""));
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.length ? unwrapLines(out) : null;
}

// 终端里占两格的字：汉字、假名、谚文、注音，CJK 标点（、到〿）与全角符号（！到｠）
const WIDE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}、-〿！-｠]/u;

function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/**
 * 终端按框宽折开的行接回成段，聊天栏比终端窄时不会一行长一行短：这一行开头的词（汉字是一个字）放在上一行（原样的那一行）
 * 末尾就超出框宽（取最宽的一行）= 是 CLI 折的，接上；放得下 = 原文就在这里换行（「Then the code:」下面接代码）。
 * 缩进的行（代码）、空行、列表 / 编号照原样；汉字前后不加空格
 */
function unwrapLines(lines: readonly string[]): string[] {
  const width = Math.max(...lines.map(cellWidth));
  const out: string[] = [];
  let lastRaw = "";
  for (const l of lines) {
    const prev = out.length ? out[out.length - 1] : "";
    const tight = WIDE.test(prev.slice(-1)) || WIDE.test(l.charAt(0));
    const unit = WIDE.test(l.charAt(0)) ? l.charAt(0) : (/^\S+/.exec(l)?.[0] ?? "");
    const wrapped =
      prev.trim() !== "" &&
      l.trim() !== "" &&
      !/^\s/.test(l) &&
      !/^\s/.test(lastRaw) &&
      !/^(?:[-*•+]|\d+[.)])\s/.test(l) &&
      cellWidth(lastRaw) + (tight ? 0 : 1) + cellWidth(unit) > width;
    if (wrapped) out[out.length - 1] = prev + (tight ? "" : " ") + l;
    else out.push(l);
    lastRaw = l;
  }
  return out;
}

/**
 * 行尾的空白与右侧滚动条（Grok / Gemini 的 █）去掉；字形后的变体选择符（U+FE0E / FE0F）也去掉——
 * Qwen 0.25.3 画「◆︎ 正文」「∴︎ Thought …」，xterm 把它并进前一格，行首符号认不出，整屏连提示一起当成回复（2026-10-21）
 */
function cleanRows(lines: readonly string[]): string[] {
  return lines.map((l) => l.replace(/[\uFE0E\uFE0F]/g, "").replace(/[\s█]+$/, ""));
}

/**
 * 这一屏有没有该家的聊天输入框：true = 在对话界面，false = 被别的全屏界面顶掉了（/usage 的 Settings 面板、
 * 登录页、全屏选择器），null = 这家没有画面布局表、不知道。tui-panel.ts 用它认「终端里开着一个面板」。
 */
export function terminalHasInputBox(lines: readonly string[], agentId: string): boolean | null {
  const layout = LAYOUTS[agentId];
  if (!layout) return null;
  return layout.boxTop(cleanRows(lines)) >= 0;
}

/**
 * 刚发的这句是不是还躺在输入框里没交出去：输入框里（框顶到下一条横线之间）去掉空白后含着这句的末尾一段。
 * 刚接回的会话（resume 回放、SessionStart 钩子还在跑）会把回车吞掉，字留在框里（2026-10-24 HER 润色实证：
 * Mesa 重启后「让 Agent 按决定继续」，接回的 Claude 把整段意见留在输入框里没发）。null = 这家没有画面布局表。
 */
export function sentTextStuckInBox(lines: readonly string[], agentId: string, sent: string): boolean | null {
  const layout = LAYOUTS[agentId];
  if (!layout) return null;
  const rows = cleanRows(lines);
  const top = layout.boxTop(rows);
  if (top < 0) return false;
  const box: string[] = [];
  for (let i = top; i < rows.length; i++) {
    const row = rows[i].trim();
    if (BORDER.test(row)) {
      if (i === top) continue;
      break;
    }
    box.push(row.replace(/^[❯›>]\s*/, ""));
  }
  const squash = (s: string) => s.replace(/\s+/g, "");
  const tail = squash(sent).slice(-16);
  return tail.length > 0 && squash(box.join("")).includes(tail);
}

/**
 * anchored = 这一屏看得见这一轮的开头（用户回显或第一段助手行首），lines 就是整段；
 * 否则回复已经长过一屏、开头滚出去了，lines 只是屏上这一截，调用方用 {@link mergeLiveReply} 接到上一次读到的后面。
 */
export interface LiveReplyRead {
  lines: string[];
  anchored: boolean;
  /**
   * 屏顶那条回显认不准时的另一种读法：按「真回显刚好滚到第一行」读（多行提问的续行要跳过）。
   * lines 是按「钉在屏顶的提问」读的（anchored = false），{@link mergeLiveReply} 接不上上一次时才改用它
   */
  ifRealEcho?: LiveReplyRead | null;
  /**
   * 这一截是从哪条回显后面读的（那一行原文）。刚发出一句、CLI 还没把它画出来时，屏上最后一条回显还是上一轮的，
   * 读出来的是上一轮的回复（2026-10-21 用户 Qwen：聊天层先把上一段回复又显示一遍）；调用方拿它和发送前的那条比
   */
  echo?: string;
}

/** italicRow：屏上第几行是斜体字（Layout.thinkItalic 的家用来认收起的思考；不给就只看文字） */
export function extractLiveReply(
  lines: readonly string[],
  agentId: string,
  italicRow?: (row: number) => boolean,
): LiveReplyRead | null {
  const layout = LAYOUTS[agentId];
  if (!layout) return null;
  // 行尾的空白与右侧滚动条（Grok / Gemini 的 █）
  const rows = cleanRows(lines);
  // 有确认菜单挂着（▔▔▔ 边框）时不预览：聊天层另有确认卡
  if (rows.some((l) => MENU_BORDER.test(l.trim()))) return null;
  // 没有输入框 = 不在对话界面（启动信任菜单、登录页、全屏选择器）：屏上的字不是回复，不预览。
  // 原先退回整屏，信任菜单的「Accessing workspace / Quick safety check」被当回复画进了聊天层（2026-10-17 用户截图）
  const boxTop = layout.boxTop(rows);
  if (boxTop < 0) return null;
  const away = layout.scrolledAway;
  if (away && rows.slice(Math.max(0, boxTop - 3), boxTop).some((l) => l.trim() !== "" && away.test(l.trim()))) return null;
  const region0 = layout.noticeBox ? dropNoticeBoxes(rows.slice(0, boxTop)) : rows.slice(0, boxTop);
  // 收起的思考（斜体）换成空行：行号不变，下面照常认回显、行首与段落
  const region = layout.thinkItalic && italicRow ? region0.map((l, i) => (l.trim() && italicRow(i) ? "" : l)) : region0;
  // 最后一条用户回显之后才是这一轮的回复；回显滚出屏幕时从第一段助手行首起
  let echoAt = -1;
  for (let i = region.length - 1; i >= 0; i--) {
    if (layout.echo.test(region[i])) {
      echoAt = i;
      break;
    }
  }
  // 屏幕第一行的回显可能是钉住的提问（下面接的是回复中段，2026-10-19 用户：Codex 第 22 行起预览卡住、
  // 或者只剩下半截）。真回显下面先是续行、再空行、再是「•」开头的一段；对不上这个形状的一定是钉住的
  if (layout.pinnedEcho && echoAt === 0 && region.length > 1) {
    const pinned = readReply(layout, region, 1, false);
    if (!realEchoShape(layout, region)) return pinned;
    const real0 = readReply(layout, region, echoStart(layout, region, 1), true);
    const real = real0 ? { ...real0, echo: region[0] } : null;
    return pinned ? { ...pinned, ifRealEcho: real } : real;
  }
  if (echoAt >= 0) {
    const start = echoStart(layout, region, echoAt + 1);
    const read = readReply(layout, region, start, !scrolledBelow(layout, region, start));
    return read ? { ...read, echo: region[echoAt] } : null;
  }
  if (layout.lead) {
    const lead = layout.lead;
    const first = region.findIndex((l) => lead.test(l) && !layout.tool.test(l));
    if (first >= 0) return readReply(layout, region, first, true);
  }
  // 开头都滚出屏了（长回复，2026-10-17 用户：显示一半后就没了）：屏上这一截全是续行——续行都有缩进。
  // 顶上是没缩进的字（启动横幅、「Tips for getting started」、排队中的提问）说明这一轮的回复还没出来，
  // 不预览（2026-10-20 Windows 抓屏：Gemini 等 MCP 初始化时提问排着队、屏上还没有回显，横幅被当成回复）
  const firstText = region.find((l) => l.trim() && !BORDER.test(l.trim()));
  if (firstText !== undefined && firstText.length - firstText.trimStart().length < 2) return null;
  return readReply(layout, region, 0, false);
}

/** 去掉顶格圆角框（╭ … ╰ 整块，含框里的行），换成空行保持行距 */
function dropNoticeBoxes(region: readonly string[]): string[] {
  const out = [...region];
  for (let i = 0; i < out.length; i++) {
    if (!/^╭/.test(out[i])) continue;
    let j = i + 1;
    while (j < out.length && /^│/.test(out[j])) j++;
    if (j < out.length && /^╰/.test(out[j])) {
      for (let k = i; k <= j; k++) out[k] = "";
      i = j;
    }
  }
  return out;
}

/** 多行提问的回显：「› 第一行」之后的续行（缩进）也是用户的话，到第一个空行或助手行首为止都跳过
 *  （2026-10-19 用户截图：Codex 里发九行清单，后八行被当成回复显示在下面） */
function echoStart(layout: Layout, region: readonly string[], start: number): number {
  const lead = layout.lead;
  if (!lead) {
    // 没有助手行首的（Grok）：提问续行对齐到回显正文那一列（「     > 」之后，缩进 7），回复正文只缩进 5。
    // 缩进够到回显正文列的非空行都是提问续行（含长提问被折成「2. … …」的末行），到空行或缩进回到正文列为止
    // （2026-10-21 用户 Windows 截图：七行清单提问的续行被当成回复，聊天层已有的段落跟着又画一遍）
    const echo = region[start - 1] ?? "";
    const m = /[❯>]\s+/.exec(echo);
    const col = m ? m.index + m[0].length : layout.indent + 2;
    while (start < region.length && region[start].trim() && region[start].length - region[start].trimStart().length >= col) {
      start++;
    }
    return start;
  }
  while (start < region.length && region[start].trim() && !lead.test(region[start])) start++;
  return start;
}

/** 第一行的回显后面像不像真回显：续行 → 至少一个空行 → 下一个有字的行是助手行首（或屏到底了） */
function realEchoShape(layout: Layout, region: readonly string[]): boolean {
  const lead = layout.lead;
  if (!lead) return true;
  let i = echoStart(layout, region, 1);
  if (i < region.length && region[i].trim()) return false;
  while (i < region.length && !region[i].trim()) i++;
  return i >= region.length || lead.test(region[i]);
}

/** 回显（及其续行）下面隔着空行是不是「上面还有」的滚动提示：是 = 回显钉在屏顶，回复开头卷上去了 */
function scrolledBelow(layout: Layout, region: readonly string[], start: number): boolean {
  if (!layout.scrolledHint) return false;
  let i = start;
  while (i < region.length && !region[i].trim()) i++;
  return i < region.length && layout.scrolledHint.test(region[i]);
}

/**
 * 表格（直角框 ┌ ├ └、行首 │）占的行。Gemini 的工具框是圆角 ╭ ╰、行首同样是 │，原先表格行一律当工具框跳过，
 * 表格在预览里只剩边框（2026-10-22 抓屏）。连续一段行首是 │ 或直角框线（┌── ├── └──）的行里有框线才算表格——工具框的行
 * 全以 │ 开头；表格上沿滚出屏时下面的 ├ / └ 照样认得出。框角后面必须紧跟横线：Codex 工具输出的「└ total 8」不算
 */
function tableRows(region: readonly string[]): boolean[] {
  const out = region.map(() => false);
  const rule = (l: string) => /^[┌├└][─┬┼┴]/.test(l.trimStart());
  const edge = (l: string) => rule(l) || /^│/.test(l.trimStart());
  let i = 0;
  while (i < region.length) {
    if (!edge(region[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < region.length && edge(region[j])) j++;
    if (region.slice(i, j).some(rule)) out.fill(true, i, j);
    i = j;
  }
  return out;
}

function readReply(layout: Layout, region: readonly string[], start: number, anchored: boolean): LiveReplyRead | null {
  const dedent = (raw: string) => {
    let n = 0;
    while (n < layout.indent && raw[n] === " ") n++;
    return raw.slice(n);
  };
  const table = tableRows(region);
  const out: string[] = [];
  let inTool = false;
  let inWrapSkip = false;
  let inThink = false;
  for (let at = start; at < region.length; at++) {
    const raw0 = region[at];
    const raw = layout.tail ? raw0.replace(layout.tail, "") : raw0;
    const t = raw.trim();
    if (layout.thinkBlock?.test(raw)) {
      inThink = true;
      continue;
    }
    if (inThink && (layout.thinkGutter ?? THINK_GUTTER).test(raw)) continue;
    inThink = false;
    if (table[at]) {
      if (!inTool) out.push(dedent(raw));
      continue;
    }
    if (BORDER.test(t) || SPINNER.test(raw)) continue;
    if (layout.tool.test(raw)) {
      // 有行首符号的几家：工具块一直到下一段正文；Grok 没有行首符号，只跳这一行
      inTool = layout.lead !== null;
      continue;
    }
    if (inWrapSkip && t && raw.length - raw.trimStart().length > layout.indent && !layout.lead?.test(raw)) continue;
    inWrapSkip = Boolean(layout.wrapSkip?.test(raw));
    if (inWrapSkip || layout.skip.test(raw)) continue;
    if (layout.lead?.test(raw)) {
      inTool = false;
      const text = raw.replace(layout.lead, "");
      // 只有行首符号没字 = 下一段还没出来的占位
      if (text.trim()) out.push(text);
      continue;
    }
    if (inTool) continue;
    out.push(dedent(raw));
  }
  // 头尾空行去掉，中间连续空行压成一行
  const compact: string[] = [];
  for (const l of out) {
    if (!l.trim() && (!compact.length || !compact[compact.length - 1].trim())) continue;
    compact.push(l);
  }
  while (compact.length && !compact[compact.length - 1].trim()) compact.pop();
  while (compact.length && !compact[0].trim()) compact.shift();
  return compact.length ? { lines: compact, anchored } : null;
}

/**
 * 把屏上这一截接到上一次读到的整段后面：在上一次里找到屏顶第一行，从那儿起换成屏上这一截——
 * 屏上画的是最新的样子，上一次在那之后的部分作废。
 *
 * 不能要求「上一次的结尾 = 这一截的开头」逐字相同：生成中 CLI 会重画正在写的那一块（2026-10-22 用户：Claude Code
 * 流式长回复，聊天层预览一遍遍重贴整屏）。实录里有：列表项先画个「-」再出字、「4.」后面才跟内容、表格每多一格
 * 列宽和行都重排、「**加粗**」收尾前后是两种样子。原先只要尾巴一处不同就整屏接在后面，每 300ms 重贴一遍。
 * 所以按「只留字母数字汉字」比（空行、表格边框、光有「-」的行不参与），从屏顶第一行在上一次里的位置起连续对上
 * 两行以上（或一直对到上一次的结尾，最后一行可以只写了半截）就算找到了。
 * 找不到时：屏上这一截大半上一次已经有了 = 重画没对上，这次不接；大半是新的 = 两次读之间滚过了一整屏，直接接上。
 */
export function mergeLiveReply(prev: readonly string[] | null, read: LiveReplyRead): string[] | null {
  if (read.anchored) {
    // 看得见开头时以整段为准；但「开头」其实缺了前几行时（Grok 卷动的过渡帧：回显还钉在屏顶、回复头一两行已被裁掉，
    // 「▲」还没画出来，2026-10-22 抓屏），上一次的开头留着，不然预览从中段开始
    if (prev?.length) {
      const p = keyedLines(prev);
      const n = keyedLines(read.lines);
      const known = new Set(n.map((x) => x.key));
      const at = n.length && p.length && !known.has(p[0].key) ? alignTop(p, n) : -1;
      if (at > 0) return spliceAt(prev, p[at].at, read.lines, n[0].at);
    }
    return read.lines;
  }
  const real = read.ifRealEcho ?? null;
  // 没见过这一轮的开头（回显 / ⏺），屏上这一截不知道是不是这一轮的：不预览
  if (!prev?.length) return real?.lines ?? null;
  const next = read.lines;
  const p = keyedLines(prev);
  const n = keyedLines(next);
  if (!n.length) return prev.slice();
  const at = alignTop(p, n);
  if (at >= 0) return spliceAt(prev, p[at].at, next, n[0].at);
  // 屏顶的回显其实是真回显（多行提问刚好滚到第一行）：屏上就是整段，开头应与上一次相同
  if (real && real.lines[0] === prev[0]) return real.lines;
  const known = new Set(p.map((x) => x.key));
  if (n.filter((x) => known.has(x.key)).length * 2 >= n.length) return prev.slice();
  return [...prev, ...next];
}

/**
 * 屏顶第一行有字的行在上一次里的位置（p 的下标），找不到为 -1：从那儿起连续对上两行以上，或一直对到上一次的结尾
 * （普通的「上一次结尾 = 屏顶」，末行可以只写了半截）。一样长取靠后的：同样几行在回复里出现两次时，屏顶是新的那处
 */
function alignTop(p: readonly Keyed[], n: readonly Keyed[]): number {
  let best = -1;
  let bestRun = 0;
  for (let s = 0; s < p.length; s++) {
    let r = 0;
    while (s + r < p.length && r < n.length) {
      const a = p[s + r].key;
      const b = n[r].key;
      if (a === b || (s + r === p.length - 1 && b.startsWith(a))) r++;
      else break;
    }
    if (r < 2 && !(r === 1 && s + r === p.length)) continue;
    if (r >= bestRun) {
      best = s;
      bestRun = r;
    }
  }
  return best;
}

/**
 * 上一次的前 cut 行 + 屏上这一截。屏顶先是空行 / 表格边框这类没字的行（next 的前 lead 行）时，上一次在那个位置的同类行
 * 换成屏上的，一行对一行（都空或都不空才换），免得表格下沿、段落间的空行接出两份
 */
function spliceAt(prev: readonly string[], cut: number, next: readonly string[], lead: number): string[] {
  let end = cut;
  for (let k = lead - 1; k >= 0 && end > 0; k--) {
    const h = prev[end - 1];
    if (norm(h) || !h.trim() !== !next[k].trim()) break;
    end--;
  }
  return [...prev.slice(0, end), ...next];
}

interface Keyed {
  at: number;
  key: string;
}

/** 有字的行（行号 + 比对键）；空行、表格边框、光有列表符号的行不参与对齐 */
function keyedLines(lines: readonly string[]): Keyed[] {
  const out: Keyed[] = [];
  lines.forEach((l, at) => {
    const key = norm(l);
    if (key) out.push({ at, key });
  });
  return out;
}

/** 只留字母、数字、汉字：终端里渲染过的 Markdown（标题去 #、行内代码去反引号、折行）和会话原文才对得上 */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 读到的这一截是不是还停在上一轮：它所在的回显与发送前屏上最后一条回显是同一行，又不像刚发的这句。
 * before = 发送前的最后一条回显（没有为 null）；sent = 刚发的原文。重复发同一句时认作新的（宁可多显示一会儿旧的）
 */
export function staleEcho(read: LiveReplyRead, before: string | null, sent: string): boolean {
  if (before === null || read.echo === undefined || read.echo !== before) return false;
  const head = norm(sent.split("\n")[0] ?? "").slice(0, 12);
  return !head || !norm(read.echo).includes(head);
}

/**
 * 读到的这一截没有回显（上一轮的提问早卷出屏了，回复从第一段助手行首读起），字又全是发送前屏上就有的：还是上一轮的尾巴。
 * {@link staleEcho} 要靠回显比，回显不在屏上时管不着——上一轮回复长过一屏、Windows 上 Claude 还没画出刚发的这句时，
 * 预览把上一轮的后半段当成了这一轮的回复（2026-10-26 用户截图）。before = 发送前屏上读出的那一截（没有为 null）
 */
export function staleWithoutEcho(read: LiveReplyRead, before: readonly string[] | null): boolean {
  if (read.echo !== undefined || !before?.length) return false;
  const known = new Set(before.map(norm).filter(Boolean));
  const keys = read.lines.map(norm).filter(Boolean);
  return keys.length > 0 && keys.every((k) => known.has(k));
}

/**
 * 去掉聊天层已经有了的行：从第一行「会话里还没有」的开始往后都算实时部分。
 * synced = 最近几条助手消息的正文（调用方拼好）
 */
export function unsyncedTail(live: readonly string[], synced: string): string[] {
  const done = norm(synced);
  // 会话文件按顺序落盘：最后一行「够长、已落盘」的及其之前都算过去了。前面混进来的非回复行（提问续行、工具输出）
  // 原先让「从第一行没落盘的起」从头算起，已落盘的段落整段又画一遍（2026-10-21 Grok 截图）。短行到处对得上，不当锚
  let from = 0;
  live.forEach((l, i) => {
    const n = norm(l);
    if (n.length >= 8 && done.includes(n)) from = i + 1;
  });
  const idx = live.findIndex((l, i) => {
    if (i < from) return false;
    const n = norm(l);
    return n.length > 0 && !done.includes(n);
  });
  return idx < 0 ? [] : live.slice(idx);
}
