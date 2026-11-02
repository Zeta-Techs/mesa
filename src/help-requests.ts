/**
 * 人工请求（`.ccode/help-wanted.md`）的前端纯逻辑：哪些条目还要人管、收件箱一行怎么写、交给 Agent 时说什么。
 * 解析在后端（help_requests.rs），这里只看解析结果。
 */
import type { HelpItemDto, HelpRequestDto, ProjectMemoryDocumentDto } from "./types";
import { helpPreview } from "./inbox.ts";

/** 还要人管的：没答的，或答了还没交给 Agent 的 */
export function helpNeedsAction(item: HelpItemDto): boolean {
  return item.sent == null;
}

export function helpUnanswered(items: readonly HelpItemDto[]): HelpItemDto[] {
  return items.filter((item) => item.answer == null && item.sent == null);
}

export function helpAnsweredUnsent(items: readonly HelpItemDto[]): HelpItemDto[] {
  return items.filter((item) => item.answer != null && item.sent == null);
}

/** 收件箱签名：要人管的条目与回答一变，忽略自动失效 */
export function helpItemsSignature(items: readonly HelpItemDto[]): string {
  return items
    .filter(helpNeedsAction)
    .map((item) => `${item.id}=${item.answer ?? ""}`)
    .join("|");
}

/** 收件箱一行：先说没答的问题；全答了只差送出就说这个 */
export function helpInboxLine(request: HelpRequestDto): string | null {
  const open = helpUnanswered(request.items);
  if (open.length > 0) {
    const more = open.length > 1 ? `（共 ${open.length} 条）` : "";
    return `有人工请求：${helpPreview(open[0].question)}${more}`;
  }
  const answered = helpAnsweredUnsent(request.items).length;
  return answered > 0 ? `${answered} 条回答还没交给 Agent` : null;
}

/** 选项按钮点下去写进文件的回答：「B（期刊 + 顶会）」 */
export function optionAnswer(key: string, label: string): string {
  return `${key}（${label}）`;
}

/** 卡片上的类别标：一般不标 */
export function helpCategoryTag(category: string): string | null {
  return category && category !== "一般" ? category : null;
}

/** 交给 Agent 继续的那句话。回答已写在文件里，这里只告诉它去哪看、看完怎么收尾 */
export function deliverHelpPrompt(answered: number, remembered: number): string {
  const memo =
    remembered > 0
      ? `其中 ${remembered} 条人要求以后同类照此办，已记进项目知识，后面遇到同类问题不要再问。`
      : "";
  return `.ccode/help-wanted.md 里有 ${answered} 条问题人已经在 Mesa 里答了（每条下面的「已答：」行）。${memo}按回答继续：把答案写进 TASK.md「已定口径」或本步报告，再把答过的这几条从 help-wanted.md 删掉；没答的保持原样，按各自「不回时」处理。然后接着做这一步还没做完的事，不要停下来等我。`;
}

/** 任务书「以前定过的事」：项目知识里仍有效、来源没变的「已定 / 不做」，新的在前，最多 15 条 */
export function ledgerLines(doc: ProjectMemoryDocumentDto): string[] {
  return doc.entries
    .filter(
      (e) =>
        e.meta.state === "active" &&
        e.stalePaths.length === 0 &&
        (e.meta.goalName === "已定" || e.meta.goalName === "不做"),
    )
    .reverse()
    .slice(0, 15)
    .map((e) => `${e.meta.goalName}：${e.text.replace(/\s+/g, " ").trim()}`);
}
