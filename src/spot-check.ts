/** 精读步「抽查 3 篇笔记」在阅读区里的核对档（2026-10-23 用户拍板：不跳运行页、对照原文看、
 *  笔记只读、问题单一次交回这一步的 AI）。纯逻辑：会话外形、问题单存取、交回 AI 的那条消息。
 *  界面在 ReaderOverlay / SpotCheckPanel，打开入口在 StepFlow，发送与勾选在 TerminalPage。 */
import type { WorkspaceDto } from "./types";

export interface SpotCheckItem {
  /** notes/index.json 里的 notePath（相对 base，或绝对路径） */
  notePath: string;
  fulltext: boolean;
  /** included.json 的 id：找题名与摘要 */
  id: string | null;
}

/** 一次抽查（readerReq.spotCheck）：三篇一起带进阅读区，在里面切篇 */
export interface SpotCheckSession {
  projectRoot: string;
  /** notes/index.json 所在根：这一步的工作区（未保存进项目，笔记只读），或项目根 */
  base: string;
  stepName: string;
  /** 人工事项标题（「都没问题」勾的就是它） */
  taskTitle: string;
  /** 这一步的工作区：问题单经它的「继续」交回原对话；没有工作区就发不了 */
  ws: WorkspaceDto | null;
  items: SpotCheckItem[];
  /** 从哪一篇开始看 */
  index: number;
}

/** spot_check_item 的返回 */
export interface SpotCheckItemDto {
  notePath: string;
  pdfPath: string | null;
  readOnly: boolean;
  title: string | null;
  abstractText: string | null;
}

export interface SpotIssue {
  /** 第几篇（items 下标） */
  item: number;
  /** 在笔记里划的，还是在原文里划的 */
  source: "note" | "pdf";
  /** 原文页码（PDF 划段才有） */
  page: number | null;
  quote: string;
  comment: string;
}

/** 每篇要看的三件事（全文 / 仅摘要分开说） */
export function spotCheckFocus(fulltext: boolean): string {
  return fulltext
    ? "看三件事：一句话总结和主要结果对得上原文；可引用点里的图号、页码在原文里找得到；没有原文里没有的数字。"
    : "这篇只按摘要记：看笔记有没有写出摘要以外的东西（方法细节、具体数值、图号）——有就是写成了读过全文。";
}

const STORE_PREFIX = "ccode.spotCheck.";

/** 问题单按 base 记在本机：误按 Esc 退出、再点进来接着记，发出或勾上后清掉 */
export function loadSpotIssues(base: string): SpotIssue[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_PREFIX + base) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter(
          (i): i is SpotIssue =>
            i && typeof i.item === "number" && typeof i.quote === "string" && typeof i.comment === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function saveSpotIssues(base: string, issues: SpotIssue[]): void {
  try {
    if (issues.length === 0) localStorage.removeItem(STORE_PREFIX + base);
    else localStorage.setItem(STORE_PREFIX + base, JSON.stringify(issues));
  } catch {
    /* 存不下只影响退出后再进，不打断核对 */
  }
}

/** 划段归一：折叠空白、限长（问题单里一眼看得出是哪句，整段原文交给 AI 没必要） */
export function spotQuote(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function notePathOf(item: SpotCheckItem): string {
  return item.notePath.replace(/\\/g, "/");
}

/** 交回这一步 AI 的那条消息：按篇分组、带出处，要求改这几篇并复查同类 */
export function buildSpotCheckPrompt(items: SpotCheckItem[], issues: SpotIssue[]): string {
  const lines = [`【抽查笔记发现的问题】我抽查了 ${items.length} 篇精读笔记，下面是要改的地方：`, ""];
  let n = 0;
  items.forEach((item, index) => {
    const mine = issues.filter((i) => i.item === index);
    if (mine.length === 0) return;
    n += 1;
    lines.push(`${n}. ${notePathOf(item)}（${item.fulltext ? "全文精读" : "仅摘要"}）`);
    for (const issue of mine) {
      const where =
        issue.source === "pdf"
          ? `原文${issue.page ? `第 ${issue.page} 页` : ""}「${issue.quote}」`
          : `笔记「${issue.quote}」`;
      const what = issue.comment.trim() || "（没写说明，请对照原文判断这里哪里不对）";
      lines.push(`   - ${where}：${what}`);
    }
  });
  lines.push(
    "",
    "请逐条对照原文改这几篇笔记：只改有问题的段落，「标注」「译段」「我的想法」原样保留。" +
      "然后按同样的问题复查其他已写的笔记，同类错误一并改；notes/index.json 的状态保持如实。" +
      "改完告诉我改了哪几篇、各改了什么。",
  );
  return lines.join("\n");
}
