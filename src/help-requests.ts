/**
 * 人工请求（`.ccode/help-wanted.md`）的前端纯逻辑：哪些条目还要人管、收件箱一行怎么写、交给 Agent 时说什么。
 * 解析在后端（help_requests.rs），这里只看解析结果。
 */
import type { HelpItemDto, HelpRequestDto } from "./types";
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

/** 交给 Agent 继续的那句话。问答原文直接写在话里：进了对话记录，Agent 中途出错把文件那一条先删了也不丢
 *  （2026-11-02 Codex 干跑实证：先删条目、追加「已定口径」的补丁没打上就收尾，回答两头都没了）。
 *  顺序写死：先记、确认记上了再删 */
export function deliverHelpPrompt(answered: readonly HelpItemDto[], remembered: number): string {
  const lines = answered.map((item, i) => `${i + 1}. ${item.question} → ${item.answer ?? ""}`).join("\n");
  const memo =
    remembered > 0
      ? `其中 ${remembered} 条人要求以后同类照此办，已记进项目知识，后面遇到同类问题不要再问。`
      : "";
  return `我在 Mesa 里答了 .ccode/help-wanted.md 的 ${answered.length} 条问题：\n${lines}\n${memo}按回答继续：先把这些答案写进 TASK.md「已定口径」（没有这一节就新建）或本步报告，确认写进去了，再把答过的这几条从 help-wanted.md 删掉；没答的保持原样，按各自「不回时」处理。然后接着做这一步还没做完的事，不要停下来等我。`;
}


/** 每个来源还要人管几条（流程线那一步上的「回答问题（N）」）；没有的不列 */
/**
 * 去掉人点过「忽略此来源」、内容也没变的那几份（签名同收件箱，屏蔽表在 inbox.ts loadHelpDismissed）。
 * 步骤卡「回答问题」、聊天层底部、评审页、收件箱、调度台 / 桌宠 / 手机都先过这一道（2026-11-11 用户：忽略了步骤卡上还在）；
 * 问题或回答变了签名就不同，各处一起重新出现
 */
export function helpNotDismissed(
  requests: readonly HelpRequestDto[],
  dismissed: Record<string, string>,
): HelpRequestDto[] {
  return requests.filter((r) => dismissed[r.root] !== helpItemsSignature(r.items));
}

export function helpPendingByRoot(requests: readonly HelpRequestDto[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of requests) {
    const n = r.items.filter(helpNeedsAction).length;
    if (n > 0) out[r.root] = n;
  }
  return out;
}
