/**
 * 审查报告与待核实清单的逐条决定。
 *
 * 步骤卡上点「接受 / 拒绝 / 修改」，写回报告里该条的「决定：」或「裁决：」。
 * Agent 读这份文件才进入第二轮改稿。去评审不负责写入这些决定。
 */

export type ReviewVerdict = "接受" | "拒绝" | "修改";

export interface ReviewItem {
  id: string;
  /** 条目正文，不含决定行。 */
  body: string;
  verdict: ReviewVerdict | null;
  /** 只在「修改」时有内容。 */
  note: string;
}

export type ReviewItemKind = "report" | "verify";

const ID_HEAD = /^(?:#{1,6}\s+)?(?:[-*]\s+)?(?:\*\*)?((?:R|S|V)\d{3,})\b/;

export function isReviewDecisionTaskTitle(title: string): boolean {
  return title.includes("逐条决定审查报告");
}

export function isVerificationDecisionTaskTitle(title: string): boolean {
  return title.includes("逐条裁决");
}

/** 审查报告与待核实清单都在步骤里逐条点，不交文件、不挂文献库同步。 */
export function isInlineDecisionTaskTitle(title: string): boolean {
  return isReviewDecisionTaskTitle(title) || isVerificationDecisionTaskTitle(title);
}

export function reviewItemKind(title: string): ReviewItemKind | null {
  if (isReviewDecisionTaskTitle(title)) return "report";
  if (isVerificationDecisionTaskTitle(title)) return "verify";
  return null;
}

/** 步骤行上只留一句：有条目、空清单、文件还没写出来、已经点完，各一句。 */
export function inlineDecisionLine(
  kind: ReviewItemKind,
  state: "open" | "empty" | "missing" | "done",
): string {
  if (state === "done") return "都已决定，点旁边的按钮回到原来的对话继续。";
  if (state === "missing") {
    return kind === "verify"
      ? "待核实清单还没写出来：AI 改完稿才写，写好会自动出现在这里。"
      : "审查报告还没写出来，写好会自动出现在这里。";
  }
  if (kind === "verify") {
    return state === "empty"
      ? "没有待核实或存疑条目，勾上跳过。"
      : "接受＝核过原文，去掉「待核实」保留这句；拒绝删掉这句；修改按你写的改，核不了就写怎么降级。";
  }
  return state === "empty"
    ? "报告里没认出编号条目（R001 起），回对话让 AI 按格式补上编号。"
    : "接受按建议改，拒绝不改，修改按你写的改。";
}

/** 决定行：`决定：接受`，或 `决定：修改：把数字改回原文`。 */
export function parseVerdictLine(line: string): { verdict: ReviewVerdict; note: string } | null {
  const matched = line.trim().match(/^(?:[-*]\s+)?决定[：:]\s*(接受|拒绝|修改)(?:[：:]\s*(.*))?$/);
  if (!matched) return null;
  const verdict = matched[1] as ReviewVerdict;
  const note = (matched[2] ?? "").trim();
  return { verdict, note: verdict === "修改" ? note : "" };
}

function fieldValue(body: string, name: string): string {
  const matched = body.match(new RegExp(`${name}[：:]\\s*([^|]*)`));
  return matched?.[1]?.trim() ?? "";
}

/** 待核实行的裁决栏。空、待裁决、括号占位都算还没拍。 */
export function verifyVerdict(body: string): { verdict: ReviewVerdict | null; note: string } {
  const raw = fieldValue(body, "裁决");
  if (!raw || raw === "待裁决" || raw.startsWith("（") || raw.startsWith("(")) {
    return { verdict: null, note: "" };
  }
  if (raw === "确认" || raw === "接受") return { verdict: "接受", note: "" };
  if (raw === "删除该论断" || raw === "拒绝") return { verdict: "拒绝", note: "" };
  if (raw === "修改" || raw.startsWith("改正为")) {
    const note = raw.replace(/^改正为\s*/, "").trim();
    const basis = fieldValue(body, "依据");
    return { verdict: "修改", note: [note, basis].filter(Boolean).join("；") };
  }
  return { verdict: null, note: "" };
}

/** Agent 预留给人填的空「决定：」行（2026-10-24 HER 实证：每条末尾都留了一行）。不进条目正文，点选时就地替换。 */
const VERDICT_PLACEHOLDER = /^(?:[-*]\s+)?决定[：:]\s*$/;

export function parseReviewItems(text: string, kind: ReviewItemKind): ReviewItem[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const items: ReviewItem[] = [];
  let current: { id: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const bodyLines: string[] = [];
    let verdict: ReviewVerdict | null = null;
    let note = "";
    for (const line of current.lines) {
      const parsed = parseVerdictLine(line);
      if (parsed) {
        verdict = parsed.verdict;
        note = parsed.note;
        continue;
      }
      if (VERDICT_PLACEHOLDER.test(line.trim())) continue;
      bodyLines.push(line);
    }
    let body = bodyLines.join("\n").trim();
    if (kind === "verify") {
      const fromField = verifyVerdict(body);
      if (!verdict) {
        verdict = fromField.verdict;
        note = fromField.note;
      }
    }
    items.push({ id: current.id, body, verdict, note });
    current = null;
  };

  for (const line of lines) {
    const head = line.trim().match(ID_HEAD);
    if (head) {
      flush();
      current = { id: head[1], lines: [line.trim()] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return items;
}

export function reviewItemsCleared(items: readonly ReviewItem[]): boolean {
  return items.length > 0 && items.every((item) => item.verdict != null);
}

function verdictLine(verdict: ReviewVerdict, note: string): string {
  const extra = verdict === "修改" ? note.trim() : "";
  return extra ? `决定：修改：${extra}` : `决定：${verdict}`;
}

/** 审查报告：在该条末尾写或替换一行「决定：」。 */
export function applyReportVerdict(
  text: string,
  id: string,
  verdict: ReviewVerdict,
  note = "",
): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => line.trim().match(ID_HEAD)?.[1] === id);
  if (start < 0) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ID_HEAD.test(lines[i].trim()) || /^#{1,6}\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  // 条目之间的空行留着，否则写决定会把这一条和下一条粘在一起
  const trailing: string[] = [];
  while (block.length > 0 && block[block.length - 1].trim() === "") trailing.push(block.pop()!);
  const last = block[block.length - 1] ?? "";
  if (parseVerdictLine(last) || VERDICT_PLACEHOLDER.test(last.trim())) block[block.length - 1] = verdictLine(verdict, note);
  else block.push(verdictLine(verdict, note));
  const next = [...lines.slice(0, start), ...block, ...trailing, ...lines.slice(end)];
  return next.join("\n");
}

function setPipeField(line: string, name: string, value: string): string {
  const pattern = new RegExp(`(${name}[：:])\\s*[^|]*?(\\s*\\|)`);
  if (pattern.test(line)) {
    return line.replace(pattern, (_all, label: string, pipe: string) => `${label}${value}${pipe}`);
  }
  const tail = new RegExp(`(${name}[：:])\\s*[^|]*$`);
  if (tail.test(line)) {
    return line.replace(tail, (_all, label: string) => `${label}${value}`);
  }
  const trimmed = line.trimEnd();
  return `${trimmed}${trimmed.includes("|") ? " | " : " "}${name}：${value}`;
}

/** 待核实行：裁决写成确认 / 删除该论断 / 改正为…；修改说明进依据。 */
export function applyVerifyVerdict(
  text: string,
  id: string,
  verdict: ReviewVerdict,
  note = "",
): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const index = lines.findIndex((line) => line.trim().match(ID_HEAD)?.[1] === id);
  if (index < 0) return text;
  const correction = note.trim().replace(/^改正为\s*/, "");
  const ruling =
    verdict === "接受" ? "确认" : verdict === "拒绝" ? "删除该论断" : `改正为${correction}`;
  let line = setPipeField(lines[index], "裁决", ruling);
  if (verdict === "修改") line = setPipeField(line, "依据", correction);
  lines[index] = line;
  return lines.join("\n");
}

/** 条目自带的改法：审查报告的「建议改法：」、待核实清单的「建议：」。选「修改」时预填，
 *  输入框里灰字显示，→ 或 Tab 补全（2026-10-24 用户：建议应该预填好，向右补全）。没有返回空串。 */
export function itemSuggestion(item: ReviewItem, kind: ReviewItemKind): string {
  const raw =
    kind === "verify"
      ? (item.body.match(/\|\s*建议[：:]\s*([^|]*)/)?.[1] ?? "")
      : (item.body.match(/建议改法[：:]\s*([\s\S]*)$/)?.[1] ?? "");
  return raw.replace(/\s+/g, " ").trim();
}

export function reviewItemSummary(item: ReviewItem, kind: ReviewItemKind): string {
  if (kind === "verify") {
    const place = fieldValue(item.body, "位置");
    const excerpt = fieldValue(item.body, "原文摘要");
    const source = fieldValue(item.body, "来源");
    return [place, excerpt, source].filter(Boolean).join(" · ") || item.body;
  }
  return item.body
    .replace(ID_HEAD, "")
    .replace(/^\s*[.、:：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 点完后接回这一步原来的对话，让 Agent 按决定继续，不打开评审页。
 *  决定写在工作区文件里，Agent 不顺手提交就挡「保存进项目」（2026-10-24 HER 润色：第二轮提交漏了 review-report.md）。
 *  待核实裁决在渲染之后才做（2026-10-24）：改完必须重渲、重出域稿、复核引用，否则交的是改之前的成稿；
 *  「确认」= 人对过原文，去掉标记，不是连标记一起留着。 */
export function continueAfterDecisionsPrompt(target: string, kind: ReviewItemKind): string {
  const file = target.trim();
  if (kind === "verify") {
    return `manuscript 里的待核实清单 ${file} 已经逐条写上裁决。写了确认的：人已对过原文，保留这句，句中的 [待核实] 标记删掉；写了删除该论断的：删掉对应句子（引用检查里的存疑条目删掉对应引用及只靠它撑的论断）；写了改正为的：按依据改，依据写明保留待核实的就留着标记。没写裁决的不要动。改完把稿件里实际剩余的 [待核实] 与清单对一遍，用本步骤 run 脚本重渲 PDF 和 Word，重新生成 output/endnote.docx 与 output/zotero.docx（LaTeX 稿不生成这两份），再按 bib-check 复核一次、结论追加进 citation-check.md，changelog 记下按裁决改了哪些句。${file} 里的裁决是 Mesa 替人写进去的，随这一轮改动一起提交。然后继续这一步还没做完的事，不要停下来等我再点评审。`;
  }
  return `${file} 里每条都已经写了「决定：」。接受和要求修改的按报告改；拒绝的不改。数字、因果、样本、结论范围的改动写入 changelog 的「科学改动」。${file} 里的决定是 Mesa 替人写进去的，随这一轮改动一起提交。改完继续这一步还没做完的事，不要停下来等我再点评审。`;
}
