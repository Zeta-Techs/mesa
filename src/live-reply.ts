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

import type { ScreenCell } from "./screen-cells.ts";

interface Layout {
  /** 输入框顶在第几行（之上是对话区）；-1 = 不在对话界面（信任菜单、登录页、全屏选择器） */
  boxTop(rows: readonly string[]): number;
  /** 用户输入的回显（这一轮从它下一行开始） */
  echo: RegExp;
  /** 助手一段的行首（匹配到的部分去掉）；Grok 没有，用 null */
  lead: RegExp | null;
  /** 工具调用那一行（它和它的续行都不进预览） */
  tool: RegExp;
  /**
   * 下一行紧跟着这种行时，这一行是工具头（不管长什么样）。Claude Code 2.1.326 跑命令时工具头写成说明文字「⏺ 写一个探针文件 · 2s」
   * （行首 ⏺ 一闪一灭，灭时是两格空白），下一行才是「  ⎿  $ 命令」；原先认不出，说明文字被当成回复挂在预览里（2026-11-25 抓屏回放）
   */
  toolHeadAbove?: RegExp;
  /** 转圈、用时、提示、装饰行 */
  skip: RegExp;
  /**
   * 这种行折行时，续行（比正文缩进深、不带符号）也跳过，到空行或下一段为止。Claude 转圈下面的「⎿  Tip: …」
   * 长过一行时，第二行「     it with "use at most 5 agents", …」原先被当成回复，一直挂在预览里（2026-10-20 用户 Windows 实测，
   * Claude Code 2.1.304；终端窄一点 Mac 上同样会折行）
   */
  wrapSkip?: RegExp;
  /**
   * CLI 绕过界面直接写进终端的告警（顶格），折下来的行也顶格。它和下面顶格、不带行首符号的行跳过，到空行为止。
   * Claude Code 2.1.311 带 API Key 启动时往 stderr 写「⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY …」，
   * 夹在这一轮中间被当成回复（2026-11-09 用户截图）
   */
  stderrNotice?: RegExp;
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
  /**
   * 输入框正上方（隔着空行）缩进到这么深的行是这家右对齐的提示栏，不是回复。Claude 2.1.311 终端获得焦点、剪贴板里有图时
   * 在那里冒「Image in clipboard · ctrl+v to paste」，还有「Conversation compacted」、tmux 提示等，字样不固定、按位置认
   * （2026-11-09 用户截图：这句挂在聊天层生成提示上）
   */
  footNote?: number;
  /**
   * 界面重绘没擦干净时，屏上会在这一轮的工具 / 思考行下面再留一份同样的提问（agy 1.5.14），
   * 读屏不拿它当这一轮的起点，见 {@link dropGhostEchoes}
   */
  ghostEcho?: boolean;
  /**
   * 提问回显折行顶格写（不额外缩进到回显正文列），直到空行 / 工具行 / 转圈行 / 横线为止都算用户提问（agy 长步骤简报回显）
   */
  echoUntilBlank?: boolean;
}

// 思考框左边那条竖线（Grok：Mesa 终端里是粗线 ┃，简化字形下是 │）
const THINK_GUTTER = /^\s*[│┃]/;
// 横线、半格边框，以及方框的上下边（画到一半的输入框「╭────」及 Windows 方角「┌────」也算；表格已先由 tableRows 放行）
const BORDER = /^[╭╰┌└]?[─━═▄▀]{8,}[╮╯┐┘]?$/;
const MENU_BORDER = /^[▔▁]{8,}$/;
// 输入框上沿除了整条横线，线上还会写字：右端「 会话名 ─」（Claude / Qwen / Grok 的 /rename，Claude 的 --agent / 队友横幅），
// 左端「─── History 2/5 」「─── ↑ 3 more 」（Claude 翻输入历史、输入折行滚动）。2026-11-25 逐家 /rename 抓屏：
// Claude 2.1.326「──… 名字 ─」、Qwen「──… 名字 ──」、Grok 圆角框「╭──… 名字 ─╮」；Codex / Kimi / Antigravity 的名字不写在框上
const LABELED_RULE = /^[─━═]{2,}(?: \S.*? )?[─━═]{8,}(?: \S.* [─━═]+)?$/;
// 圆角 / 方角输入框的上沿（Grok、Kimi）：「╭────╮」，线上也可能写着会话名「╭──── 名字 ─╮」
const BOX_TOP = /^\s*[╭┌][─━]+(?: \S.*? [─━]+)?[╮┐]$/;

/**
 * 横线画的输入框上沿（整条横线，或线上写着会话名 / 输入历史等字）。原先只认整条横线，会话起了名就认不出输入框，
 * 答完一切回聊天层就弹「终端在等你」（2026-11-25 用户实测，/rename 后抓屏复现）
 */
export function promptTopRule(row: string): boolean {
  const t = row.trim();
  return BORDER.test(t) || LABELED_RULE.test(t);
}
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
// 2.1.311 起折叠行连着思考用时：做完「Thought for 10s, read 1 file」，进行中「Thinking for 10s, reading 1 file…」
// 「Reading 2 files…」，进行中行首的 ⏺ 一闪一灭（灭时是两格空白）。原先进行中的写法认不出，当成回复显示（2026-11-09 用户截图）
const CLAUDE_GROUP =
  /^(?:[⏺●]\s+|\s*)(?:(?:Thinking|Thought) for \d|(?:Reading|Searching for|Listing|Editing|Running|Calling|Recalling|Writing|Making) \d)/;
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
    // 输入框上边框：最后一条「❯」行的上一行是横线（线上可能写着会话名，promptTopRule）
    boxTop: (rows) => lastBox(rows, (i) => (i > 0 && /^❯/.test(rows[i]) && promptTopRule(rows[i - 1]) ? i - 1 : -1)),
    echo: /^❯\s+\S/,
    // 行首符号：macOS / Linux 是 ⏺，Windows 上 Claude Code 画 ●（控制台字体没有 ⏺，2026-10-20 ConPTY 抓屏）
    lead: /^[⏺●]\s?/,
    // 工具名可以是两个词：「Web Search(…)」「Notebook Edit(…)」（旧写法 [A-Za-z]* 漏掉带空格的，整行被当成正文）；
    // 括号必须紧跟字母，「⏺ Note (important)…」这种正文不会误判
    tool: new RegExp(`^[⏺●]\\s+[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*\\(|${TOOL_SUMMARY.source}|${CLAUDE_GROUP.source}`),
    skip: CLAUDE_STATUS,
    wrapSkip: /^\s*⎿/,
    // 被打断的那一行「⎿  Interrupted · …」、转圈下的「⎿  Tip: …」也紧跟在正文下面，不算工具头
    toolHeadAbove: /^\s*⎿(?!\s*(?:Interrupted\b|Tip:))\s/,
    stderrNotice: /^⚠\s|⚠ claude\.ai connectors are disabled/,
    footNote: 24,
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
    // 「• Starting MCP servers (2/6): …（1s • esc to interrupt）」是启动状态行，窗口窄时折成两行、首行不带 esc to interrupt
    skip: /^•\s+(?:Working|Starting MCP)\b|esc to interrupt|^\s*(?:─+\s*)?Worked for\b|^\s*└/,
    indent: 2,
    pinnedEcho: true,
    // 0.164 tui/src/transcript_view/composer_gap.rs 的几种写法：「↓ Back to bottom · esc」「↓ Bottom」「New activity · ↓ …」
    scrolledAway: /^(?:↓\s*)?(?:New activity(?:\s+·\s+)?)?(?:↓(?:\s+(?:Back to bottom|Bottom))?(?:\s+·\s+esc)?)?$/,
  },
  qwen: {
    boxTop: (rows) => lastBox(rows, (i) => (i > 0 && /^>\s/.test(rows[i]) && promptTopRule(rows[i - 1]) ? i - 1 : -1)),
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
    // 「Executing Hooks: <命令>」：跑全局 hooks 时画在状态区（输入框上方、「? for shortcuts」上一行），不是回复（2026-11-25 抓屏）
    skip: /esc to cancel|Shift\+Tab to |auto-accept edits|^\s*YOLO\b.*Ctrl\+Y|\? for shortcuts|\bMCP servers?\b|\b\d+ skills?\s*$|Press Ctrl\+O to expand|^\s*[╭│╰]|^\s*Executing Hooks?:/,
    // 段落续行缩进 2、列表缩进 3
    indent: 3,
  },
  grok: {
    // Windows 上 Grok 换了一套字形（2026-10-20 ConPTY 抓屏）：回显与输入框 ❯ → >，工具 ◆ → ♦，代码块标签 ◇ → ○；
    // 1.0.89 起 Windows 输入框也从圆角 ╭──╮ 换成方角 ┌──┐（2026-11-18 金丝雀抓屏）
    boxTop: (rows) =>
      lastBox(rows, (i) => (BOX_TOP.test(rows[i]) && /^\s*│\s*[❯>]/.test(rows[i + 1] ?? "") ? i : -1)),
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
      lastBox(rows, (i) => (BOX_TOP.test(rows[i]) && /^\s*│\s*>/.test(rows[i + 1] ?? "") ? i : -1)),
    echo: /^\s*❯\s+\S/,
    lead: /^\s*●\s/,
    tool: new RegExp(`^\\s*[●✗✓•]\\s+${TOOL_VERB}\\b`),
    // 2.3 等首字时转月相「🌑 · Tip: …」（2026-10-21 抓屏；用户截图里 🌕Kimi 叠在「正在回复」上面）。
    // MCP 服务连上 / 失败 / 要登录时插进对话区的状态行「MCP server "x" needs OAuth — run /mcp-config login x」
    // （2.3.2 McpStatus finalizeMcpServerStatusRow；2026-10-26 用户 Windows 截图：接在回复后面成了正文）
    // 收起的思考下面那行「… (12 more lines, ctrl+o to expand)」也不是回复。
    // 2.6.1 一轮说完在输入框上方补画「Worked for 10s · done 6:08 PM」（2026-11-16 用户截图：接在回复后面成了正文）
    skip: /Press Ctrl\+B to run in background|^\s*Tool ".*" was not run|^\s*Rejected:|^\s*[\u{1F311}-\u{1F318}]|^\s*·\s*Tip:|^\s*MCP server ".+?" (?:connected\b|failed\b|needs OAuth\b|disabled$|removed$|connecting…)|^\s*… \(\d+ more lines?, ctrl\+o to expand\)|^\s*Worked for\b/u,
    // 思考中（2.3.2 ThinkingComponent live）：「⠋ thinking…」下面缩进两格、只留思考原文的最后两行；想完收成斜体的「● …」一段。
    // 2.6.1 思考中的头一行换成「● Thinking」（不是斜体），下面照旧缩进的斜体原文
    thinkBlock: /^\s*(?:[⠀-⣿]\s+thinking…|●\s+Thinking)\s*$/,
    thinkGutter: /^(?=\s{2,}\S)/,
    thinkItalic: true,
    indent: 3,
  },
  agy: {
    // Antigravity CLI 1.5.8 抓屏：输入框包在上下两条 ──── 横线中间（`>` 或多行草稿），审批菜单时输入框收起（`> 1. Yes…` 下方无横线）；
    // 工具行 `○  Running (...)` / `●  Ran (...)` 下跟 `  ⎿  ...` 缩进输出，思考与等待态是 `  ⣷  思考摘要`（续行缩进 5 格），正上方偶挂 `  └ Tip:`；
    // 1.5.14 实测：另有折叠思考条 `▸ Thought for 47s, 1.2k tokens`、告警块 `⚠ Warning` + `  ⎿  ...`、以及输入框上方右对齐的 `1 artifact · /artifact to review`
    boxTop: (rows) =>
      lastBox(rows, (i) =>
        i > 0 &&
        /^>(?:\s|$)/.test(rows[i]) &&
        promptTopRule(rows[i - 1]) &&
        rows.slice(i + 1, i + 12).some((line) => BORDER.test(line.trim()))
          ? i - 1
          : -1,
      ),
    echo: /^>\s+\S/,
    ghostEcho: true,
    echoUntilBlank: true,
    lead: null,
    tool: /^\s*[●○]\s/,
    skip: /^\s*─{4,}\s*$|^─*\s*Conversation compacted\b|\bConversation compacted\s*─*$|^\s*…\s*\d+\s+more\s+(?:actions?|lines?|items?|tools?)\b|^\s*[▸▾]\s*Thought for \d|\b\d+\s+artifacts?\s*·\s*\/artifact\s+to\s+review\b|esc to cancel|\? for shortcuts|\(ctrl\+o to expand\)|shift\+tab to cycle|^\s*└\s*Tip:/i,
    wrapSkip: /^\s*(?:⎿|└\s*Tip:)/,
    stderrNotice: /^\s*⚠\s/,
    footNote: 24,
    thinkBlock: /^\s*[\u2800-\u28ff]\s+/,
    thinkGutter: /^ {3,}/,
    indent: 2,
  },
};

/**
 * 转圈行里这一轮已生成的 token 数（Claude Code「✶ Musing… (5s · ↓ 1.2k tokens)」、CodeBuddy 2.185
 * 「✹ Waking… (2s · streaming · ↓ 10 tokens)」）→ 1200 / 10。
 * Windows 上 Claude Code 与两平台上的 CodeBuddy 都是整条消息收完才画正文（2026-10-21 / 2026-11-18 金丝雀抓屏），
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

/** 屏上转圈行带「↓ N tokens」的家：就算没有逐字正文预览（CodeBuddy）也能在聊天层报已生成 token 数 */
export function outputTokensSupported(agentId: string): boolean {
  return agentId === "claude-code" || agentId === "codebuddy";
}

export function liveReplySupported(agentId: string): boolean {
  return agentId in LAYOUTS;
}

/**
 * Claude Code 这一轮还在跑：输入框下面的提示行带「esc to interrupt」（2.1.310 抓屏：「⏸ manual mode on · esc to interrupt」，
 * 按 Esc 打断后只剩「⏸ manual mode on」）。打断后看屏确认回合真停了再收旁路的回合（TerminalPage settleAfterEsc）。
 * 2.1.311 起提示行不再写「esc to interrupt」（只剩「⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent」），
 * 另认转圈行「✶ Sprouting… (50s · deep in thought …)」：做完收成「✻ Cooked for 57s · done」，不带「…(」。
 * 原先只认提示行，「立即发送」（Esc 打断、排着的那句马上交）之后新开的一轮被当成已打断收掉，
 * 聊天层写「这一轮已中断」、终端还在想（2026-11-09 用户截图）
 */
export function claudeTurnActiveOnScreen(lines: readonly string[]): boolean {
  return lines.some((l) => /\besc to interrupt\b/i.test(l) || /^\s*[^\s\w]\s+[^\s…]+…\s*\(/u.test(l));
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
  if (agentId === "agy") {
    const first = rows[at].replace(/^\s*[\u2800-\u28ff]\s+/, "").trim();
    if (!first || /^(?:Generating|Working|Thinking|Running|Loading)\.{0,3}$/i.test(first)) return null;
    const agyBody = [first];
    for (let j = at + 1; j < boxTop && /^ {4,}\S/.test(rows[j]) && !SPINNER.test(rows[j]) && !layout.skip.test(rows[j]); j++) {
      const part = rows[j].trim();
      if (part && part !== "…") agyBody.push(part);
    }
    return unwrapLines(agyBody);
  }
  const body: string[] = [];
  // Kimi 2.5 在「thinking…」和思考原文之间空一行（2026-11-11 用户截图：聊天层一会只有「思考中」、一会带内容）；
  // 框里的行不含转圈和提示（还没出原文时，空行下面就是缩进的「⠏ Working…」）
  let i = at + 1;
  while (i < boxTop && !rows[i].trim()) i++;
  for (; i < boxTop && gutter.test(rows[i]) && !SPINNER.test(rows[i]) && !layout.skip.test(rows[i]); i++) {
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

// 不能出现在行首的标点：CLI 折行时把它和前一个字一起推到下一行（Grok 折「…材 / 料，…」，2026-10-26 Mac 抓屏）
const NO_LINE_START = /^[，。、；：？！）」』】》〉…—,.;:?!)\]}]+/u;

/**
 * 终端按框宽折开的行接回成段，聊天栏比终端窄时不会一行长一行短：这一行开头的词（汉字是一个字，连同后面不能放行首的标点）
 * 放在上一行（原样的那一行）末尾就超出框宽（取最宽的一行）= 是 CLI 折的，接上；放得下 = 原文就在这里换行（「Then the code:」下面接代码）。
 * 缩进的行（代码）、空行、列表 / 编号照原样；汉字前后不加空格
 */
function unwrapLines(lines: readonly string[]): string[] {
  const width = Math.max(...lines.map(cellWidth));
  const out: string[] = [];
  let lastRaw = "";
  for (const l of lines) {
    const prev = out.length ? out[out.length - 1] : "";
    const tight = WIDE.test(prev.slice(-1)) || WIDE.test(l.charAt(0));
    const unit = WIDE.test(l.charAt(0))
      ? l.charAt(0) + (NO_LINE_START.exec(l.slice(1))?.[0] ?? "")
      : (/^\S+/.exec(l)?.[0] ?? "");
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
    // 上沿那行（可能写着会话名）不算框里的字
    if (i === top) continue;
    const row = rows[i].trim();
    if (BORDER.test(row)) break;
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
/** 读屏预览还原出的行内样式片段（从 xterm 单元格属性映射成聊天层语义排版，不照搬终端裸色） */
export interface LiveStyledSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  dim?: boolean;
  /** 行内代码提示（带终端底色，或带前景色且长得像代码/路径/标识符） */
  code?: boolean;
  /** 带前景色但不像代码（彩色强调词、列表标记等） */
  accent?: boolean;
}

/** 读屏预览还原出的一行（与 lines[i] 一一对应） */
export interface LiveStyledLine {
  text: string;
  spans: LiveStyledSpan[];
  /** 直角框线表格行（┌ ├ └ │）：等宽对齐渲染 */
  table?: boolean;
  /** 整行带终端底色的代码块行 */
  codeBlock?: boolean;
  /** 整行加粗的短小节标题行 */
  heading?: boolean;
}

export interface LiveReplyRead {
  lines: string[];
  anchored: boolean;
  /** 传入 rowCells 时一并抽出每行样式片段，与 lines 一一对应 */
  styled?: LiveStyledLine[];
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

/** italicRow：屏上第几行是斜体字（Layout.thinkItalic 的家用来认收起的思考；不给就只看文字）
 *  rowCells：可选，读屏上第 row 行的单元格样式，用于把终端已渲染的粗体/斜体/代码/标题还原进聊天层实时预览 */
export function extractLiveReply(
  lines: readonly string[],
  agentId: string,
  italicRow?: (row: number) => boolean,
  rowCells?: (row: number) => readonly ScreenCell[],
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
  const region0 = dropBannerBlocks(
    layout.noticeBox ? dropNoticeBoxes(rows.slice(0, boxTop)) : rows.slice(0, boxTop),
  );
  if (layout.footNote) dropFootNotes(region0, layout.footNote);
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
  if (layout.ghostEcho && echoAt > 0) echoAt = dropGhostEchoes(layout, region, echoAt);
  // 屏幕第一行的回显可能是钉住的提问（下面接的是回复中段，2026-10-19 用户：Codex 第 22 行起预览卡住、
  // 或者只剩下半截）。真回显下面先是续行、再空行、再是「•」开头的一段；对不上这个形状的一定是钉住的
  if (layout.pinnedEcho && echoAt === 0 && region.length > 1) {
    const pinned = readReply(layout, region, 1, false, rowCells);
    if (!realEchoShape(layout, region)) return pinned;
    const real0 = readReply(layout, region, echoStart(layout, region, 1), true, rowCells);
    const real = real0 ? { ...real0, echo: region[0] } : null;
    return pinned ? { ...pinned, ifRealEcho: real } : real;
  }
  if (echoAt >= 0) {
    const start = echoStart(layout, region, echoAt + 1);
    const read = readReply(layout, region, start, !scrolledBelow(layout, region, start), rowCells);
    return read ? { ...read, echo: region[echoAt] } : null;
  }
  if (layout.lead) {
    const lead = layout.lead;
    const first = region.findIndex((l) => lead.test(l) && !layout.tool.test(l));
    if (first >= 0) return readReply(layout, region, first, true, rowCells);
  }
  // 开头都滚出屏了（长回复，2026-10-17 用户：显示一半后就没了）：屏上这一截全是续行——续行都有缩进。
  // 顶上是没缩进的字（启动横幅、「Tips for getting started」、排队中的提问）说明这一轮的回复还没出来，
  // 不预览（2026-10-20 Windows 抓屏：Gemini 等 MCP 初始化时提问排着队、屏上还没有回显，横幅被当成回复）
  const firstText = region.find((l) => l.trim() && !BORDER.test(l.trim()) && !layout.skip.test(l));
  if (firstText !== undefined && firstText.length - firstText.trimStart().length < 2) return null;
  return readReply(layout, region, 0, false, rowCells);
}

/** 输入框正上方右对齐的提示行换成空行（从下往上，跳过空行，遇到不够深的行为止） */
function dropFootNotes(region: string[], depth: number): void {
  for (let i = region.length - 1; i >= 0; i--) {
    const l = region[i];
    if (!l.trim()) continue;
    if (l.length - l.trimStart().length < depth) return;
    region[i] = "";
  }
}

const BANNER_ART = /[▄▀█░▒▓▌▐▖▗▘▙▚▛▜▝▞▟]{2,}/;
const BANNER_META = /\b(?:Antigravity CLI|Claude Code|Gemini CLI|Kimi Code|Grok Build)\s+v?\d/i;

/**
 * 去掉屏幕里的启动横幅像素画块（2026-11-21 用户 Antigravity CLI 1.5.14 截图：像素 logo 顶行缩进 6 格，
 * 绕过「首行缩进 < 2」闸门，整块 Antigravity CLI 1.5.14 / Gemini API key / 模型 / 路径被拼进实时预览）。
 * 连续两行以上含块字符像素画，或像素画行旁紧跟 CLI 版本标题行时整块置空，保持行号不变。
 */
function dropBannerBlocks(region: readonly string[]): string[] {
  const out = [...region];
  const isArtRow = (l: string) => {
    const t = l.trim();
    return t.length > 0 && !BORDER.test(t) && BANNER_ART.test(t);
  };
  let i = 0;
  while (i < out.length) {
    if (!isArtRow(out[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < out.length && isArtRow(out[j])) j++;
    const slice = out.slice(i, j);
    if (slice.length >= 2 || slice.some((l) => BANNER_META.test(l))) {
      for (let k = i; k < j; k++) out[k] = "";
    }
    i = j;
  }
  return out;
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

// 残影里夹着的边框碎片（只剩框线、块字符）与计时（「3m 9s」「45s」）
const GHOST_RULE = /^[─-▟]+$/;
const GHOST_TIMER = /^\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s$/;

/**
 * 提问残影（Layout.ghostEcho）：agy 1.5.14 跑长任务时界面重绘没擦干净，这一轮的工具 / 思考行下面又留了一份同样的提问，
 * 夹着边框碎片「──── 追求卓越…」和计时「3m 9s」。读屏把它当成这一轮的回显，后面几段提问连同计时画成了回复
 * （2026-11-23 用户截图）。
 * 最后一条回显与上一条回显一字不差，上一条从第一行工具 / 思考 / 状态行起到这条之前没有回复正文，这条就是残影：
 * 起点退回上一条，残影这一块（空行、框线碎片、提问里有的字、计时）换成空行，行号不变。
 * 同一句真发了两次、上一轮又没回话时，这样读与按后一条读结果相同；上一轮在工具之前回过话、
 * 后一条下面又不是这句提问的字时不算残影。返回这一轮回显所在的行
 */
function dropGhostEchoes(layout: Layout, region: string[], echoAt: number): number {
  const turnRow = (l: string) =>
    layout.tool.test(l) || SPINNER.test(l) || Boolean(layout.thinkBlock?.test(l)) || layout.skip.test(l);
  let at = echoAt;
  for (let round = 0; round < 4; round++) {
    let prev = at - 1;
    while (prev >= 0 && !layout.echo.test(region[prev])) prev--;
    if (prev < 0 || region[prev].trim() !== region[at].trim()) break;
    let turnAt = prev + 1;
    while (turnAt < at && !turnRow(region[turnAt])) turnAt++;
    if (turnAt >= at || readReply(layout, region.slice(0, at), turnAt, false)) break;
    const asked = norm(region.slice(prev, turnAt).join("\n"));
    const askedBody = region.slice(prev + 1, turnAt).some((l) => norm(l));
    let end = at + 1;
    let echoed = false;
    for (; end < region.length; end++) {
      const l = region[end];
      const t = l.trim();
      if (!t || GHOST_RULE.test(t) || GHOST_TIMER.test(l)) continue;
      const n = norm(l);
      if (!n || !asked.includes(n)) break;
      echoed = true;
    }
    if (askedBody && !echoed) break;
    region.fill("", at, end);
    at = prev;
  }
  return at;
}

/** 多行提问的回显：「› 第一行」之后的续行（缩进）也是用户的话，到第一个空行或助手行首为止都跳过
 *  （2026-10-19 用户截图：Codex 里发九行清单，后八行被当成回复显示在下面） */
function echoStart(layout: Layout, region: readonly string[], start: number): number {
  const lead = layout.lead;
  if (!lead) {
    if (layout.echoUntilBlank) {
      // agy 长提问折行可能顶格或缩进 2 格，紧连到空行 / 工具行 / 思考转圈 / 分隔线为止都算提问回显（2026-11-21 用户截图）
      while (
        start < region.length &&
        region[start].trim() &&
        !layout.tool.test(region[start]) &&
        !layout.thinkBlock?.test(region[start]) &&
        !SPINNER.test(region[start]) &&
        !BORDER.test(region[start].trim()) &&
        !layout.skip.test(region[start])
      ) {
        start++;
      }
      return start;
    }
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

const CODE_SYMBOL = /[/_=<>(){}[\]$`~\\|@#%^&*+.:-]/;

/** 仅带前景色（无底色）的片段像不像代码 / 路径 / 标识符，而不是中文彩色提示词或列表符号 */
function looksLikeInlineCode(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^[-*•+‣◦]$|^\d+[.)]$/.test(t)) return false;
  if (/[，。、；：？！「」『』【】（）]/.test(t)) return false;
  let ascii = 0;
  let han = 0;
  for (const ch of t) {
    if (ch <= "\x7f" && !/\s/.test(ch)) ascii++;
    else if (/\p{Script=Han}/u.test(ch)) han++;
  }
  if (ascii === 0) return false;
  if (han > 0) return CODE_SYMBOL.test(t) && ascii >= han;
  return true;
}

interface RawSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  dim: boolean;
  bg: boolean;
  hasFg: boolean;
}

function buildStyledLine(
  text: string,
  cells: readonly ScreenCell[] | undefined,
  trimLeft: number,
  table: boolean,
): LiveStyledLine {
  if (!text) return { text, spans: [] };
  if (!cells || cells.length === 0) {
    return table ? { text, spans: [{ text }], table: true } : { text, spans: [{ text }] };
  }
  const start = trimLeft;
  const end = trimLeft + text.length;
  const raw: RawSpan[] = [];
  let pos = 0;
  for (const c of cells) {
    const ch = c.ch.replace(/[\uFE0E\uFE0F]/g, "");
    const len = ch.length;
    if (len === 0) continue;
    const cStart = pos;
    const cEnd = pos + len;
    pos = cEnd;
    if (cEnd <= start) continue;
    if (cStart >= end) break;
    const slice = ch.slice(Math.max(0, start - cStart), Math.min(len, end - cStart));
    if (!slice) continue;
    const bold = Boolean(c.bold);
    const italic = Boolean(c.italic);
    const underline = Boolean(c.underline);
    const strike = Boolean(c.strike);
    const dim = Boolean(c.dim);
    const bg = Boolean(c.bg);
    const hasFg = Boolean(c.fg);
    const prev = raw[raw.length - 1];
    if (
      prev &&
      prev.bold === bold &&
      prev.italic === italic &&
      prev.underline === underline &&
      prev.strike === strike &&
      prev.dim === dim &&
      prev.bg === bg &&
      prev.hasFg === hasFg
    ) {
      prev.text += slice;
    } else {
      raw.push({ text: slice, bold, italic, underline, strike, dim, bg, hasFg });
    }
  }
  // 防御：宽字符 / 变体选择符极端错位时回退成纯文本，保证展示文字与 lines 严格一致
  if (raw.map((s) => s.text).join("") !== text) {
    return table ? { text, spans: [{ text }], table: true } : { text, spans: [{ text }] };
  }

  let nonSpaceChars = 0;
  let bgNonSpaceChars = 0;
  let allBold = true;
  for (const r of raw) {
    for (const ch of r.text) {
      if (/\s/.test(ch)) continue;
      nonSpaceChars++;
      if (r.bg) bgNonSpaceChars++;
      if (!r.bold) allBold = false;
    }
  }
  const trimmed = text.trim();
  const fullBg = nonSpaceChars > 0 && bgNonSpaceChars * 5 >= nonSpaceChars * 4;
  // 整行带底色的只有像代码的行才当代码块（Codex 用户回显、中文提示条整行也有浅灰底，不能套成代码块）
  const codeBlock = !table && fullBg && looksLikeInlineCode(trimmed);
  const heading =
    !table &&
    !codeBlock &&
    nonSpaceChars > 0 &&
    allBold &&
    trimmed.length <= 80 &&
    !/^(?:[-*•+‣◦]|\d+[.)])\s/.test(trimmed) &&
    !/[。；;!?！？]$/.test(trimmed);

  const spans: LiveStyledSpan[] = [];
  for (const r of raw) {
    const span: LiveStyledSpan = { text: r.text };
    if (r.bold && !heading) span.bold = true;
    if (r.italic) span.italic = true;
    if (r.underline) span.underline = true;
    if (r.strike) span.strike = true;
    if (r.dim) span.dim = true;
    if (!table && !codeBlock && !heading) {
      if (r.bg && r.text.trim() && (!fullBg || looksLikeInlineCode(r.text))) {
        span.code = true;
      } else if (r.hasFg && !r.bold && !r.dim && !r.underline) {
        if (looksLikeInlineCode(r.text)) span.code = true;
        else if (r.text.trim()) span.accent = true;
      }
    }
    const prev = spans[spans.length - 1];
    if (
      prev &&
      Boolean(prev.bold) === Boolean(span.bold) &&
      Boolean(prev.italic) === Boolean(span.italic) &&
      Boolean(prev.underline) === Boolean(span.underline) &&
      Boolean(prev.strike) === Boolean(span.strike) &&
      Boolean(prev.dim) === Boolean(span.dim) &&
      Boolean(prev.code) === Boolean(span.code) &&
      Boolean(prev.accent) === Boolean(span.accent)
    ) {
      prev.text += span.text;
    } else {
      spans.push(span);
    }
  }

  const out: LiveStyledLine = { text, spans };
  if (table) out.table = true;
  if (codeBlock) out.codeBlock = true;
  if (heading) out.heading = true;
  return out;
}

function readReply(
  layout: Layout,
  region: readonly string[],
  start: number,
  anchored: boolean,
  rowCells?: (row: number) => readonly ScreenCell[],
): LiveReplyRead | null {
  const dedentCount = (raw: string) => {
    let n = 0;
    while (n < layout.indent && raw[n] === " ") n++;
    return n;
  };
  const table = tableRows(region);
  const out: Array<{ text: string; styled?: LiveStyledLine }> = [];
  const pushRow = (at: number, text: string, trimLeft: number, isTable: boolean) => {
    out.push({
      text,
      styled: rowCells ? buildStyledLine(text, rowCells(at), trimLeft, isTable) : undefined,
    });
  };
  let inTool = false;
  let inWrapSkip = false;
  let toolParenDepth = 0;
  let inNotice = false;
  let inThink = false;
  let thinkBody = false;
  const parenDelta = (s: string) => {
    let d = 0;
    for (const ch of s) {
      if (ch === "(") d++;
      else if (ch === ")") d--;
    }
    return d;
  };
  for (let at = start; at < region.length; at++) {
    const raw0 = region[at];
    const raw = layout.tail ? raw0.replace(layout.tail, "") : raw0;
    const t = raw.trim();
    if (layout.thinkBlock?.test(raw)) {
      inThink = true;
      thinkBody = false;
      toolParenDepth = 0;
      continue;
    }
    // 头一行下面紧跟的空行还在框里（Kimi 2.5，同 extractLiveThinking）
    if (inThink && !t && !thinkBody) continue;
    if (inThink && !SPINNER.test(raw) && (layout.thinkGutter ?? THINK_GUTTER).test(raw)) {
      thinkBody = true;
      continue;
    }
    inThink = false;
    if (table[at]) {
      toolParenDepth = 0;
      if (!inTool) {
        const n = dedentCount(raw);
        pushRow(at, raw.slice(n), n, true);
      }
      continue;
    }
    if (BORDER.test(t) || SPINNER.test(raw)) {
      toolParenDepth = 0;
      continue;
    }
    if (layout.stderrNotice?.test(raw)) {
      inNotice = true;
      toolParenDepth = 0;
      continue;
    }
    if (inNotice && t && !/^\s/.test(raw) && !layout.lead?.test(raw)) continue;
    inNotice = false;
    if (layout.tool.test(raw)) {
      // 有行首符号的几家：工具块一直到下一段正文；无行首符号的家（Grok / agy）跳这一行及其折行续行
      inTool = layout.lead !== null;
      if (layout.lead === null) {
        inWrapSkip = true;
        toolParenDepth = Math.max(0, parenDelta(raw));
      } else {
        toolParenDepth = 0;
      }
      continue;
    }
    // 无行首符号的家（agy 等）工具摘要折行（如 `● Edit file (Update ...` 括号未闭合折到下一行，缩进 2 格）：
    // 一直跳过直到括号闭合、省略号收尾或空行（2026-11-21 用户截图回归）
    if (toolParenDepth > 0) {
      if (t && raw.length - raw.trimStart().length >= layout.indent && !layout.wrapSkip?.test(raw) && !layout.skip.test(raw)) {
        toolParenDepth = /(?:\.\.\.|…)\s*$/.test(t) ? 0 : Math.max(0, toolParenDepth + parenDelta(raw));
        continue;
      }
      toolParenDepth = 0;
    }
    if (inWrapSkip && t && raw.length - raw.trimStart().length > layout.indent && !layout.lead?.test(raw)) continue;
    inWrapSkip = Boolean(layout.wrapSkip?.test(raw));
    if (inWrapSkip || layout.skip.test(raw)) continue;
    if (t && layout.toolHeadAbove?.test(region[at + 1] ?? "")) {
      inTool = layout.lead !== null;
      continue;
    }
    if (layout.lead?.test(raw)) {
      inTool = false;
      const m = layout.lead.exec(raw);
      const cut = m ? m[0].length : 0;
      const text = raw.slice(cut);
      // 只有行首符号没字 = 下一段还没出来的占位
      if (text.trim()) pushRow(at, text, cut, false);
      continue;
    }
    if (inTool) continue;
    const n = dedentCount(raw);
    pushRow(at, raw.slice(n), n, false);
  }
  // 头尾空行去掉，中间连续空行压成一行
  const compact: Array<{ text: string; styled?: LiveStyledLine }> = [];
  for (const item of out) {
    if (!item.text.trim() && (!compact.length || !compact[compact.length - 1].text.trim())) continue;
    compact.push(item);
  }
  while (compact.length && !compact[compact.length - 1].text.trim()) compact.pop();
  while (compact.length && !compact[0].text.trim()) compact.shift();
  if (!compact.length) return null;
  const lines = compact.map((c) => c.text);
  if (!rowCells) return { lines, anchored };
  return {
    lines,
    anchored,
    styled: compact.map((c) => c.styled ?? { text: c.text, spans: c.text ? [{ text: c.text }] : [] }),
  };
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
function plainStyled(lines: readonly string[]): LiveStyledLine[] {
  return lines.map((text) => ({ text, spans: text ? [{ text }] : [] }));
}

function spliceCut(prev: readonly string[], cut: number, next: readonly string[], lead: number): number {
  let end = cut;
  for (let k = lead - 1; k >= 0 && end > 0; k--) {
    const h = prev[end - 1];
    if (norm(h) || !h.trim() !== !next[k].trim()) break;
    end--;
  }
  return end;
}

/**
 * 把屏上这一截（文本行 + 可选样式行）同步接到上一次后面，确保 lines 与 styled 始终 1:1 下标对齐。
 */
export function mergeLiveReplyStyled(
  prev: { lines: readonly string[]; styled?: readonly LiveStyledLine[] | null } | null,
  read: LiveReplyRead,
): { lines: string[]; styled: LiveStyledLine[] | null } | null {
  const prevLines = prev?.lines ?? null;
  const hasStyled = Boolean(prev?.styled || read.styled || read.ifRealEcho?.styled);
  const prevStyled = prevLines ? (prev?.styled ?? (hasStyled ? plainStyled(prevLines) : null)) : null;
  const readStyled = read.styled ?? (hasStyled ? plainStyled(read.lines) : null);

  if (read.anchored) {
    if (prevLines?.length) {
      const p = keyedLines(prevLines);
      const n = keyedLines(read.lines);
      const known = new Set(n.map((x) => x.key));
      const at = n.length && p.length && !known.has(p[0].key) ? alignTop(p, n) : -1;
      if (at > 0) {
        const end = spliceCut(prevLines, p[at].at, read.lines, n[0].at);
        return {
          lines: [...prevLines.slice(0, end), ...read.lines],
          styled: hasStyled && prevStyled && readStyled ? [...prevStyled.slice(0, end), ...readStyled] : null,
        };
      }
    }
    return { lines: read.lines, styled: read.styled ?? null };
  }
  const real = read.ifRealEcho ?? null;
  if (!prevLines?.length) {
    return real ? { lines: real.lines, styled: real.styled ?? null } : null;
  }
  const next = read.lines;
  const p = keyedLines(prevLines);
  const n = keyedLines(next);
  if (!n.length) {
    return { lines: prevLines.slice(), styled: prevStyled ? prevStyled.slice() : null };
  }
  const at = alignTop(p, n);
  if (at >= 0) {
    const end = spliceCut(prevLines, p[at].at, next, n[0].at);
    return {
      lines: [...prevLines.slice(0, end), ...next],
      styled: hasStyled && prevStyled && readStyled ? [...prevStyled.slice(0, end), ...readStyled] : null,
    };
  }
  if (real && real.lines[0] === prevLines[0]) {
    return { lines: real.lines, styled: real.styled ?? null };
  }
  const known = new Set(p.map((x) => x.key));
  if (n.filter((x) => known.has(x.key)).length * 2 >= n.length) {
    return { lines: prevLines.slice(), styled: prevStyled ? prevStyled.slice() : null };
  }
  return {
    lines: [...prevLines, ...next],
    styled: hasStyled && prevStyled && readStyled ? [...prevStyled, ...readStyled] : null,
  };
}

export function mergeLiveReply(prev: readonly string[] | null, read: LiveReplyRead): string[] | null {
  return mergeLiveReplyStyled(prev ? { lines: prev } : null, read)?.lines ?? null;
}

/** 按匀速显示（useRevealedText）的字符上限裁切样式行，保持与纯文本拼接（join("\n")）严格等长 */
export function sliceStyledLines(lines: readonly LiveStyledLine[], maxChars: number): LiveStyledLine[] {
  if (maxChars <= 0 || lines.length === 0) return [];
  const out: LiveStyledLine[] = [];
  let rem = maxChars;
  for (let i = 0; i < lines.length && rem > 0; i++) {
    if (i > 0) {
      rem -= 1; // "\n"
      if (rem <= 0) break;
    }
    const line = lines[i];
    if (line.text.length <= rem) {
      out.push(line);
      rem -= line.text.length;
      continue;
    }
    const slicedSpans: LiveStyledSpan[] = [];
    let spanRem = rem;
    for (const sp of line.spans) {
      if (spanRem <= 0) break;
      if (sp.text.length <= spanRem) {
        slicedSpans.push(sp);
        spanRem -= sp.text.length;
      } else {
        slicedSpans.push({ ...sp, text: sp.text.slice(0, spanRem) });
        spanRem = 0;
      }
    }
    out.push({ ...line, text: line.text.slice(0, rem), spans: slicedSpans });
    rem = 0;
  }
  return out;
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
 * before = 发送前的最后一条回显（没有为 null）；sent = 刚发的原文。
 * 重复发同一句时回显分不出新旧，改看回复：字全是发送前屏上就有的（beforeLines）= 还是上一轮的。原先一律认作新的，
 * 接回会话后再发一句「你好」，上一轮的回复整段挂在「正在回复」里直到新回复出字（2026-10-27 用户截图）。
 * 新回复碰巧与上一轮一字不差时要等会话文件落盘才出来，比把旧的当新的好
 */
export function staleEcho(
  read: LiveReplyRead,
  before: string | null,
  sent: string,
  beforeLines: readonly string[] | null = null,
): boolean {
  if (before === null || read.echo === undefined || read.echo !== before) return false;
  const head = norm(sent.split("\n")[0] ?? "").slice(0, 12);
  if (head && norm(read.echo).includes(head)) return linesKnown(read.lines, beforeLines);
  return true;
}

/** 读到的每一行有字的都在 before 里（before 为空时不算） */
function linesKnown(lines: readonly string[], before: readonly string[] | null): boolean {
  if (!before?.length) return false;
  const known = new Set(before.map(norm).filter(Boolean));
  const keys = lines.map(norm).filter(Boolean);
  return keys.length > 0 && keys.every((k) => known.has(k));
}

/**
 * 去掉开头那几行人刚问的话：分好几段的提问（项目里开新对话时附的项目说明、空行隔开的清单）在终端回显里也隔着空行，
 * 读屏只认得出第一段是回显，后面几段当成了回复，聊天层把整段提问又画一遍、光标接在末尾
 * （2026-10-26 用户截图）。asked = 最近一条用户消息的原文（含折起来的项目说明）。
 * 只去开头连着的、按顺序能在提问里找到的行；短行（折行剩下的「pdf」、回复里的「好的」）只在紧接上一行时才算。
 * 回复第一行一旦对不上，后面一律保留
 */
export function dropAskedEchoOffset(live: readonly string[], asked: string): number {
  const q = norm(asked);
  if (!q) return 0;
  let pos = -1;
  let i = 0;
  while (i < live.length) {
    const n = norm(live[i]);
    if (n) {
      const at = n.length >= 4 ? q.indexOf(n, Math.max(pos, 0)) : pos >= 0 && q.startsWith(n, pos) ? pos : -1;
      if (at < 0) break;
      pos = at + n.length;
    }
    i++;
  }
  return i;
}

export function dropAskedEcho(live: readonly string[], asked: string): string[] {
  return live.slice(dropAskedEchoOffset(live, asked));
}

/**
 * 读到的这一截没有回显（上一轮的提问早卷出屏了，回复从第一段助手行首读起），字又全是发送前屏上就有的：还是上一轮的尾巴。
 * {@link staleEcho} 要靠回显比，回显不在屏上时管不着——上一轮回复长过一屏、Windows 上 Claude 还没画出刚发的这句时，
 * 预览把上一轮的后半段当成了这一轮的回复（2026-10-26 用户截图）。before = 发送前屏上读出的那一截（没有为 null）
 */
export function staleWithoutEcho(read: LiveReplyRead, before: readonly string[] | null): boolean {
  if (read.echo !== undefined) return false;
  return linesKnown(read.lines, before);
}

/**
 * 实时预览读到的这一截是不是整段都在上一轮的回复里（prev = 上一轮助手正文）：是就还是上一轮的，不当这一轮的预览。
 * 有一行对不上就不算——新回复碰巧与上一轮有一行相同不受影响
 */
export function sameAsPrevReply(live: readonly string[], prev: string): boolean {
  const done = norm(prev);
  if (!done) return false;
  const keys = live.map(norm).filter(Boolean);
  return keys.length > 0 && keys.every((k) => done.includes(k));
}

/**
 * 扩展防串轮：紧邻上一轮按 `sameAsPrevReply` 直接拦截；若读屏整段较长（≥2 行且 ≥40 个有效字符）且全部落在更早轮次
 * 已落盘的正文里（例如当前轮长时间跑工具、终端画面还留着两轮前的长回复），同样判定为旧回复不予展示；
 * 短句（如「好的」）只跟紧邻上一轮比，避免误伤新回复里的常见短句。
 */
export function sameAsEarlierReply(live: readonly string[], prevTurn: string, earlierTurns: string): boolean {
  if (sameAsPrevReply(live, prevTurn)) return true;
  if (!earlierTurns) return false;
  const keys = live.map(norm).filter(Boolean);
  const totalLen = keys.reduce((acc, k) => acc + k.length, 0);
  if (keys.length < 2 || totalLen < 40) return false;
  return sameAsPrevReply(live, earlierTurns);
}

/**
 * 去掉聊天层已经有了的行：从第一行「会话里还没有」的开始往后都算实时部分。
 * synced = 最近几条助手消息的正文（调用方拼好）
 */
export function unsyncedTailOffset(live: readonly string[], synced: string): number {
  const done = norm(synced);
  // 会话文件按顺序落盘：最后一行「够长、已落盘」的及其之前都算过去了。前面混进来的非回复行（提问续行、工具输出）
  // 原先让「从第一行没落盘的起」从头算起，已落盘的段落整段又画一遍（2026-10-21 Grok 截图）。短行到处对得上，不当锚
  let from = 0;
  live.forEach((l, i) => {
    const n = norm(l);
    if (n.length >= 8 && done.includes(n)) from = i + 1;
  });
  return live.findIndex((l, i) => {
    if (i < from) return false;
    const n = norm(l);
    return n.length > 0 && !done.includes(n);
  });
}

export function unsyncedTail(live: readonly string[], synced: string): string[] {
  const idx = unsyncedTailOffset(live, synced);
  return idx < 0 ? [] : live.slice(idx);
}
