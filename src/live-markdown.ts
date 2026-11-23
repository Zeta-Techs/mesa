/**
 * 聊天层结构化旁路（Codex / Qwen / OpenCode）流式 Markdown 渲染的纯逻辑：
 * - 分块（splitStreamingMarkdownBlocks）：把已写完的顶层块与正在写的末尾块分开，已完成块不变即可 memo，避免高亮/公式闪烁；
 * - 补全（completeStreamingMarkdown）：对末尾块里尚未闭合的围栏代码、行内代码、粗体、斜体、删除线与半截链接/图片做无闪烁稳态补全；
 * - 同步去重（unsyncedMarkdownTail）：在会话文件追上时剔除已落盘行，但保留紧挨未落盘正文前的围栏 / 公式起手行。
 */
import { unsyncedTailOffset } from "./live-reply.ts";

interface FenceState {
  ch: "`" | "~";
  len: number;
}

function matchFenceOpen(line: string): FenceState | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const ch = m[1][0] as "`" | "~";
  // CommonMark: backtick info string cannot contain backticks
  if (ch === "`" && line.slice(m[0].length).includes("`")) return null;
  return { ch, len: m[1].length };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const re = fence.ch === "`" ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/;
  const m = re.exec(line);
  return Boolean(m && m[1].length >= fence.len);
}

function isPartialFenceClose(line: string, fence: FenceState): boolean {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(m && m[1][0] === fence.ch && m[1].length < fence.len);
}

/**
 * 把流式 Markdown 切成独立的顶层块（按空行切分，不切开围栏代码块与块级公式 $$ / \[）。
 * 除最后一块外，前面的块在后续增量到达时字符串完全不变，React.memo 可直接跳过重渲染与二次高亮。
 */
export function splitStreamingMarkdownBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: FenceState | null = null;
  let mathBlock: "$$" | "\\[" | null = null;

  const flush = () => {
    while (buf.length > 0 && !buf[0].trim()) buf.shift();
    while (buf.length > 0 && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length > 0) blocks.push(buf.join("\n"));
    buf = [];
  };

  for (const line of lines) {
    if (fence) {
      buf.push(line);
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    if (mathBlock) {
      buf.push(line);
      if (mathBlock === "$$" && /^ {0,3}\$\$[ \t]*$/.test(line)) mathBlock = null;
      else if (mathBlock === "\\[" && /^ {0,3}\\\][ \t]*$/.test(line)) mathBlock = null;
      continue;
    }

    const opened = matchFenceOpen(line);
    if (opened) {
      fence = opened;
      buf.push(line);
      continue;
    }

    // 块级公式起手（单行已闭合的 $$...$$ 或 \[...\] 不进入多行态）
    if (/^ {0,3}\$\$[ \t]*$/.test(line)) {
      mathBlock = "$$";
      buf.push(line);
      continue;
    }
    if (/^ {0,3}\\\[[ \t]*$/.test(line)) {
      mathBlock = "\\[";
      buf.push(line);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/**
 * 补全流式输出末尾一块里未闭合的 Markdown 语法，避免先闪 `**`、`` ` ``、半截围栏或半截链接再跳变。
 */
export function completeStreamingMarkdown(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) return "";
  const lines = normalized.split("\n");
  let fence: FenceState | null = null;
  let mathBlock: "$$" | "\\[" | null = null;
  let lastClosedBlock = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const isLast = idx === lines.length - 1;
    if (fence) {
      if (isFenceClose(line, fence)) {
        fence = null;
        if (isLast) lastClosedBlock = true;
      }
      continue;
    }
    if (mathBlock) {
      if (mathBlock === "$$" && /^ {0,3}\$\$[ \t]*$/.test(line)) {
        mathBlock = null;
        if (isLast) lastClosedBlock = true;
      } else if (mathBlock === "\\[" && /^ {0,3}\\\][ \t]*$/.test(line)) {
        mathBlock = null;
        if (isLast) lastClosedBlock = true;
      }
      continue;
    }
    const opened = matchFenceOpen(line);
    if (opened) {
      fence = opened;
      continue;
    }
    if (/^ {0,3}\$\$[ \t]*$/.test(line)) {
      mathBlock = "$$";
      continue;
    }
    if (/^ {0,3}\\\[[ \t]*$/.test(line)) {
      mathBlock = "\\[";
    }
  }

  // 未闭合围栏代码块：去掉末尾半截闭合符（如刚吐出 ``）后显式闭合
  if (fence) {
    const out = lines.slice();
    if (out.length > 1 && isPartialFenceClose(out[out.length - 1], fence)) {
      out.pop();
    }
    out.push(fence.ch.repeat(fence.len));
    return out.join("\n");
  }

  // 未闭合块级公式或末尾行刚闭合围栏 / 块级公式：保留原样，不按行内语法处理
  if (mathBlock || lastClosedBlock) return normalized;

  const last = lines[lines.length - 1];
  // 刚吐出 `#` / `##` 还没到标题正文：先藏掉这行，免得裸露井号闪一下
  if (/^ {0,3}#{1,6}[ \t]*$/.test(last)) {
    return lines.slice(0, -1).join("\n");
  }

  lines[lines.length - 1] = completeInlineLine(last);
  return lines.join("\n");
}

function completeInlineLine(line: string): string {
  if (!line) return line;
  // 水平分割线（*** / --- / ___）原样保留，不把 *** 误补成 *****
  if (/^ {0,3}(?:>\s*)*(?:[-*_][ \t]*){3,}$/.test(line)) return line;
  // 先处理末尾未闭合的链接 / 图片语法（只在反引号之外）：`![alt](url...` 或 `[label](url...`
  const stable = stripDanglingLinkOrImage(line);
  // 跳过行首无序列表标记 `* `，免得把列表符当成斜体起手
  const listLead = /^( {0,3}(?:>\s*)*[*+-][ \t]+)/.exec(stable);
  const start = listLead ? listLead[1].length : 0;

  let inCode = 0;
  let codeStart = -1;
  let inMath = false;
  let boldOpen = false;
  let boldStart = -1;
  let strikeOpen = false;
  let strikeStart = -1;
  let italicOpen = false;
  let italicStart = -1;

  let i = start;
  while (i < stable.length) {
    const ch = stable[i];
    if (ch === "\\" && !inCode) {
      // 跳过转义字符与 \( \) 行内公式
      if (stable[i + 1] === "(") inMath = true;
      else if (stable[i + 1] === ")") inMath = false;
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (stable[i + run] === "`") run++;
      if (inCode === 0) {
        inCode = run;
        codeStart = i;
      } else if (run === inCode) {
        inCode = 0;
        codeStart = -1;
      }
      i += run;
      continue;
    }
    if (inCode > 0) {
      i++;
      continue;
    }
    if (ch === "$") {
      if (stable[i + 1] === "$") {
        inMath = !inMath;
        i += 2;
        continue;
      }
      // 货币金额（如 $100、$3.50）与空白后的裸 $ 不当成行内公式起手
      const after = stable.slice(i);
      if (
        !inMath &&
        (/^\$(?:\s|$)/.test(after) || /^\$\d+(?:[.,]\d+)?(?=\s|$|[，。、；：！？)\]}])/.test(after))
      ) {
        i++;
        continue;
      }
      inMath = !inMath;
      i++;
      continue;
    }
    if (inMath) {
      i++;
      continue;
    }
    if (ch === "*" && stable[i + 1] === "*") {
      if (boldOpen) {
        boldOpen = false;
        boldStart = -1;
      } else {
        boldOpen = true;
        boldStart = i;
      }
      i += 2;
      continue;
    }
    if (ch === "~" && stable[i + 1] === "~") {
      if (strikeOpen) {
        strikeOpen = false;
        strikeStart = -1;
      } else {
        strikeOpen = true;
        strikeStart = i;
      }
      i += 2;
      continue;
    }
    if (ch === "*") {
      // 仅把后紧跟非空白的 * 视为斜体起手，或闭合已有斜体；若 boldOpen 且行尾刚吐出半个 `*`，留到收尾补单 `*`
      if (boldOpen && i === stable.length - 1) {
        i++;
        continue;
      }
      if (italicOpen) {
        italicOpen = false;
        italicStart = -1;
      } else if (i + 1 < stable.length && !/\s/.test(stable[i + 1])) {
        italicOpen = true;
        italicStart = i;
      }
      i++;
      continue;
    }
    i++;
  }

  let out = stable;
  if (inCode > 0) {
    const after = out.slice(codeStart + inCode);
    if (!after) return out.slice(0, codeStart);
    return out + "`".repeat(inCode);
  }
  if (inMath) return out;

  // 若末尾刚吐出裸起手符（如 `这是 ***` / `这是 **` / `这是 ~~` / `这是 *`），先收掉免得闪一下符号
  if (boldOpen && (boldStart + 2 === out.length || (boldStart + 3 === out.length && out.endsWith("*")))) {
    return out.slice(0, boldStart);
  }
  if (strikeOpen && (strikeStart + 2 === out.length || (strikeStart + 3 === out.length && out.endsWith("~")))) {
    return out.slice(0, strikeStart);
  }
  if (italicOpen && italicStart + 1 === out.length) {
    return out.slice(0, italicStart);
  }
  if (!boldOpen && !italicOpen && /(?:^|\s)\*$/.test(out)) {
    return out.slice(0, -1);
  }

  // 按嵌套逆序补齐闭合标记
  const openers: Array<{ at: number; close: string }> = [];
  if (boldOpen) {
    const halfClose = out.endsWith("*") && boldStart + 2 < out.length - 1;
    openers.push({ at: boldStart, close: halfClose ? "*" : "**" });
  }
  if (strikeOpen) {
    const halfClose = out.endsWith("~") && strikeStart + 2 < out.length - 1;
    openers.push({ at: strikeStart, close: halfClose ? "~" : "~~" });
  }
  if (italicOpen) {
    openers.push({ at: italicStart, close: "*" });
  }
  openers.sort((a, b) => b.at - a.at);
  for (const o of openers) {
    // 只有起手符后确实有非空白正文才闭合（避免 `** ` 变 `** **`）
    if (out.slice(o.at).trim().length > 2 || (o.close === "*" && out.slice(o.at).trim().length > 1)) {
      out += o.close;
    }
  }
  return out;
}

/** 末尾处于未闭合 `[label](partial` 或 `![alt](partial`（不在行内代码内）时，暂显示标签正文不漏出半截 URL */
function stripDanglingLinkOrImage(line: string): string {
  // 简单检查最后一个 `](` 是否在反引号之外且之后没有 `)`
  let inCode = 0;
  let lastBracket = -1;
  let lastImg = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && !inCode) {
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run++;
      if (inCode === 0) inCode = run;
      else if (run === inCode) inCode = 0;
      i += run - 1;
      continue;
    }
    if (inCode > 0) continue;
    if (ch === "[" && (i === 0 || line[i - 1] !== "\\")) {
      lastBracket = i;
      lastImg = i > 0 && line[i - 1] === "!" && (i < 2 || line[i - 2] !== "\\");
    }
  }
  if (lastBracket < 0) return line;
  const tail = line.slice(lastBracket);
  const m = /^\[([^\]\n]*)\]\(([^)\n]*)$/.exec(tail);
  if (!m) return line;
  const cutAt = lastImg ? lastBracket - 1 : lastBracket;
  return line.slice(0, cutAt) + m[1];
}

const MD_OPENER_LINE = /^ {0,3}(?:`{3,}|~{3,}|\$\$|\\\[)[ \t]*$/;

/**
 * Markdown 旁路版的未落盘尾部截取：
 * - 还没有已落盘正文时原样保留（不跳过开头的裸围栏 ``` 或 $$）；
 * - 有已落盘正文时与 unsyncedTail 同口径，但若紧挨第一行未落盘内容前是裸围栏 / 公式起手行则一并带上。
 */
export function unsyncedMarkdownTail(live: readonly string[], synced: string): string[] {
  if (!live.length) return [];
  if (!synced.trim()) return [...live];
  let idx = unsyncedTailOffset(live, synced);
  if (idx < 0) return [];
  while (idx > 0 && MD_OPENER_LINE.test(live[idx - 1])) {
    idx--;
  }
  return live.slice(idx);
}
