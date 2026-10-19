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
 *   Grok Build 1.0：  「❯ 回显（缩进 5，右侧时间）/ 正文无行首符号（缩进 5）/ ◆ Running … / ⠧ Responding… / ╭ │ ❯ │ ╰」
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
  /** 续行去掉的缩进（空格数，最多去这么多） */
  indent: number;
  /** 行尾要去掉的东西（Grok 右侧的时间） */
  tail?: RegExp;
}

// 横线、半格边框，以及方框的上下边（画到一半的输入框「╭────」也算）
const BORDER = /^[╭╰]?[─━═▄▀]{8,}[╮╯]?$/;
const MENU_BORDER = /^[▔▁]{8,}$/;
const SPINNER = /^\s*[\u2800-\u28ff]\s/;
// Claude：转圈 / 用时 / 右对齐的思考档提示：✻ Sautéed for 7s · done、✶ Thinking…、● high · /effort；
// 还有两种界面提示，聊天层里按不了、也不是回复：「Thought for 7s (ctrl+o to expand)」（思考折叠行，不带行首符号，
// 会被当成上一段的续行）和任何「(ctrl+o to expand)」「(ctrl+r to …)」这类快捷键提示（2026-10-19 用户截图）
const CLAUDE_STATUS =
  /^\s*(?:[✻✶✳✢✽✺∴*·●◈]\s|Thought for \d|.*·\s*\/effort\s*$)|\(ctrl\+[a-z] to [^)]*\)\s*$/;
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
    lead: /^⏺\s?/,
    // 工具名可以是两个词：「Web Search(…)」「Notebook Edit(…)」（旧写法 [A-Za-z]* 漏掉带空格的，整行被当成正文）；
    // 括号必须紧跟字母，「⏺ Note (important)…」这种正文不会误判
    tool: new RegExp(`^⏺\\s+[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*\\(|${TOOL_SUMMARY.source}`),
    skip: new RegExp(`${CLAUDE_STATUS.source}|^\\s*⎿`),
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
  },
  qwen: {
    boxTop: (rows) => lastBox(rows, (i) => (i > 0 && /^>\s/.test(rows[i]) && BORDER.test(rows[i - 1].trim()) ? i - 1 : -1)),
    echo: /^\s{1,3}>\s+\S/,
    lead: /^\s*◆\s/,
    // 「  ? Shell echo …」「  - Shell …」「  ✓ ReadFile …」：顶两格 + 状态符号 + 工具名（正文列表缩进更深）
    tool: /^ {2}[?✓✔✗✘⊷○◐-]\s+[A-Z]/,
    skip: /esc to cancel|^\s*●\s*$|Waiting for user confirmation/,
    // 段落续行缩进 4、列表 / 代码行缩进 5：最多去 5 格，两种都对齐到行首
    indent: 5,
  },
  gemini: {
    // 输入框与回显都包在 ▄▄▄ / ▀▀▀ 半格边框里：最后一个才是输入框
    boxTop: (rows) =>
      lastBox(rows, (i) => (i > 0 && /^\s?>\s/.test(rows[i]) && /^▄{8,}$/.test(rows[i - 1].trim()) ? i - 1 : -1)),
    echo: /^\s?>\s+\S/,
    lead: /^✦\s/,
    tool: /^\s*[╭│╰]/,
    skip: /esc to cancel|Shift\+Tab to accept edits|\? for shortcuts|MCP servers?\s*$|^\s*[╭│╰]/,
    // 段落续行缩进 2、列表缩进 3
    indent: 3,
  },
  grok: {
    boxTop: (rows) =>
      lastBox(rows, (i) => (/^\s*╭[─━]+╮$/.test(rows[i]) && /^\s*│\s*❯/.test(rows[i + 1] ?? "") ? i : -1)),
    echo: /^\s+❯\s+\S/,
    lead: null,
    tool: /^\s*◆\s/,
    skip: /Responding…|^\s*Worked for\b|^\s*◇\s+\S+\s+\[Copy\]$/,
    indent: 5,
    tail: /\s{2,}\d{1,2}:\d{2}\s?[AP]M$/,
  },
  kimi: {
    boxTop: (rows) =>
      lastBox(rows, (i) => (/^\s*╭[─━]+╮$/.test(rows[i]) && /^\s*│\s*>/.test(rows[i + 1] ?? "") ? i : -1)),
    echo: /^\s*❯\s+\S/,
    lead: /^\s*●\s/,
    tool: new RegExp(`^\\s*[●✗✓•]\\s+${TOOL_VERB}\\b`),
    skip: /Press Ctrl\+B to run in background|^\s*Tool ".*" was not run|^\s*Rejected:/,
    indent: 3,
  },
};

export function liveReplySupported(agentId: string): boolean {
  return agentId in LAYOUTS;
}

/**
 * 这一屏有没有该家的聊天输入框：true = 在对话界面，false = 被别的全屏界面顶掉了（/usage 的 Settings 面板、
 * 登录页、全屏选择器），null = 这家没有画面布局表、不知道。tui-panel.ts 用它认「终端里开着一个面板」。
 */
export function terminalHasInputBox(lines: readonly string[], agentId: string): boolean | null {
  const layout = LAYOUTS[agentId];
  if (!layout) return null;
  const rows = lines.map((l) => l.replace(/[\s█]+$/, ""));
  return layout.boxTop(rows) >= 0;
}

/**
 * anchored = 这一屏看得见这一轮的开头（用户回显或第一段助手行首），lines 就是整段；
 * 否则回复已经长过一屏、开头滚出去了，lines 只是屏上这一截，调用方用 {@link mergeLiveReply} 接到上一次读到的后面。
 */
export interface LiveReplyRead {
  lines: string[];
  anchored: boolean;
}

export function extractLiveReply(lines: readonly string[], agentId: string): LiveReplyRead | null {
  const layout = LAYOUTS[agentId];
  if (!layout) return null;
  // 行尾的空白与右侧滚动条（Grok / Gemini 的 █）
  const rows = lines.map((l) => l.replace(/[\s█]+$/, ""));
  // 有确认菜单挂着（▔▔▔ 边框）时不预览：聊天层另有确认卡
  if (rows.some((l) => MENU_BORDER.test(l.trim()))) return null;
  // 没有输入框 = 不在对话界面（启动信任菜单、登录页、全屏选择器）：屏上的字不是回复，不预览。
  // 原先退回整屏，信任菜单的「Accessing workspace / Quick safety check」被当回复画进了聊天层（2026-10-17 用户截图）
  const boxTop = layout.boxTop(rows);
  if (boxTop < 0) return null;
  const region = rows.slice(0, boxTop);
  // 最后一条用户回显之后才是这一轮的回复；回显滚出屏幕时从第一段助手行首起
  let start = -1;
  for (let i = region.length - 1; i >= 0; i--) {
    if (layout.echo.test(region[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0 && layout.lead) {
    const lead = layout.lead;
    start = region.findIndex((l) => lead.test(l) && !layout.tool.test(l));
  }
  // 多行提问的回显：「› 第一行」之后的续行（缩进）也是用户的话，到第一个空行或助手行首为止都跳过
  // （2026-10-19 用户截图：Codex 里发九行清单，后八行被当成回复显示在下面）
  if (start >= 0 && layout.lead) {
    const lead = layout.lead;
    while (start < region.length && region[start].trim() && !lead.test(region[start])) start++;
  }
  // 开头都滚出屏了（长回复，2026-10-17 用户：显示一半后就没了）：屏上这一截全是续行
  const anchored = start >= 0;
  if (!anchored) start = 0;

  const dedent = (raw: string) => {
    let n = 0;
    while (n < layout.indent && raw[n] === " ") n++;
    return raw.slice(n);
  };
  const out: string[] = [];
  let inTool = false;
  for (const raw0 of region.slice(start)) {
    const raw = layout.tail ? raw0.replace(layout.tail, "") : raw0;
    const t = raw.trim();
    if (BORDER.test(t) || SPINNER.test(raw)) continue;
    if (layout.tool.test(raw)) {
      // 有行首符号的几家：工具块一直到下一段正文；Grok 没有行首符号，只跳这一行
      inTool = layout.lead !== null;
      continue;
    }
    if (layout.skip.test(raw)) continue;
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
 * 把屏上这一截接到上一次读到的整段后面：找「上一次的结尾」与「这一截的开头」最长的重合，
 * 重合部分只留一份。找不到重合（两次读之间滚过了一整屏）就直接接上——宁可漏几行也不重复。
 */
export function mergeLiveReply(prev: readonly string[] | null, read: LiveReplyRead): string[] | null {
  if (read.anchored) return read.lines;
  // 没见过这一轮的开头（回显 / ⏺），屏上这一截不知道是不是这一轮的：不预览
  if (!prev?.length) return null;
  const next = read.lines;
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        same = false;
        break;
      }
    }
    // 只靠空行重合不算数
    if (same && next.slice(0, k).some((l) => l.trim())) return [...prev, ...next.slice(k)];
  }
  return [...prev, ...next];
}

/** 只留字母、数字、汉字：终端里渲染过的 Markdown（标题去 #、行内代码去反引号、折行）和会话原文才对得上 */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 去掉聊天层已经有了的行：从第一行「会话里还没有」的开始往后都算实时部分。
 * synced = 最近几条助手消息的正文（调用方拼好）
 */
export function unsyncedTail(live: readonly string[], synced: string): string[] {
  const done = norm(synced);
  const idx = live.findIndex((l) => {
    const n = norm(l);
    return n.length > 0 && !done.includes(n);
  });
  return idx < 0 ? [] : live.slice(idx);
}
