import { useState, type ReactNode } from "react";
import {
  CHECK_DISCLAIMER,
  CHECK_STATUS_LABEL,
  checkLocation,
  checkQuoteLine,
  checkSourceLabel,
  groupChecks,
  type CheckItem,
  type CheckStatus,
  type ChecksDto,
} from "../research-checks";

const STATUS_TONE: Record<CheckStatus, string> = {
  blocked: "text-err-text",
  needs_human: "text-warn-text",
  passed: "text-l3",
};

const STATUS_DOT: Record<CheckStatus, string> = {
  blocked: "bg-err-text",
  needs_human: "bg-warn-text",
  passed: "bg-l4",
};

/**
 * 评审页「核验」标签展开的核验清单：按 拦下 / 待你判断 / 通过 分组，通过默认收起。
 * 2026-11-11 用户「这里的 UI 优化一下」：原来每条标题整行染红 / 黄、说明全文铺开、动作夹在位置和来源中间，一屏全是彩色长字。
 * 现在颜色只留在左侧小圆点和分组名上；标题正常字色，位置与来源压成一行灰字；说明默认一行，点开看全文；动作靠右。
 * 顶上「全部加进意见」把拦下和待你判断的一并加进意见栏，并写明请 AI 逐条判断（该改的改，不用改的说明理由）。
 */
export default function CheckList({
  checks,
  onConsult,
  onAddNote,
  onAddAll,
  isNoted,
  children,
}: {
  checks: ChecksDto;
  /** 待你判断的一条「请几家研讨这一条」（研讨二期）；不给就不出按钮 */
  onConsult?: (item: CheckItem) => void;
  /** 拦下 / 待你判断的一条加进退回意见（评审页意见栏）；不给就不出按钮 */
  onAddNote?: (item: CheckItem) => void;
  /** 拦下 / 待你判断的全部加进意见，交 AI 逐条判断 */
  onAddAll?: (items: CheckItem[]) => void;
  /** 这一条是否已经在意见里（按钮显示「已加入」） */
  isNoted?: (item: CheckItem) => boolean;
  /** 列表下面、说明上面挂的一块（大纲：覆盖检查对照） */
  children?: ReactNode;
}) {
  const [showPassed, setShowPassed] = useState(false);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const groups = groupChecks(checks.items);
  const open = checks.items.filter((item) => item.status !== "passed");
  const pending = open.filter((item) => !isNoted?.(item));
  const toggle = (key: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section aria-label="核验清单" className="mt-1.5 border-t border-hairline pt-1.5">
      {onAddAll && open.length > 1 && (
        <div className="mb-1 flex items-center gap-2 text-micro text-l4">
          <span>拦下和待你判断的，可以一起交给 AI 逐条判断：该改的改，不用改的说明理由。</span>
          <button
            type="button"
            disabled={pending.length === 0}
            onClick={() => onAddAll(open)}
            title="把这些条目都加进右边的意见栏，开头写明请 AI 逐条判断、不要照单全改；加完还能在栏里删改"
            className="ml-auto shrink-0 rounded-sm border border-field px-2 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:cursor-default disabled:opacity-50"
          >
            {pending.length === 0 ? "都已加进意见" : `全部加进意见（${open.length}）`}
          </button>
        </div>
      )}
      {groups.map((group) => {
        const collapsed = group.status === "passed" && !showPassed;
        return (
          <div key={group.status} className="mb-1">
            <button
              type="button"
              disabled={group.status !== "passed"}
              aria-expanded={group.status === "passed" ? showPassed : undefined}
              onClick={() => setShowPassed((v) => !v)}
              className={`px-2 text-micro ${STATUS_TONE[group.status]} ${group.status === "passed" ? "hover:text-l1" : "cursor-default"}`}
            >
              {CHECK_STATUS_LABEL[group.status]} {group.items.length}
              {group.status === "passed" && (showPassed ? " · 收起" : " · 展开")}
            </button>
            {!collapsed && (
              <ul>
                {group.items.map((item) => {
                  const where = checkLocation(item);
                  const quote = checkQuoteLine(item);
                  const key = `${item.id}-${where}`;
                  const expanded = openIds.has(key);
                  const noted = isNoted?.(item) ?? false;
                  const hasMore = Boolean(quote || item.evidence?.detail);
                  return (
                    <li key={key} className="flex gap-2 rounded-md px-2 py-1 hover:bg-hover">
                      <span aria-hidden="true" className={`mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[item.status]}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs leading-snug text-l1">{item.title}</p>
                        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-micro text-l4">
                          {where && <span className="font-mono">{where}</span>}
                          {where && <span aria-hidden="true">·</span>}
                          <span title={item.checker === "mesa" ? "Mesa 自己按文件数出来的，不经 AI" : undefined}>
                            {checkSourceLabel(item)}
                          </span>
                        </p>
                        {hasMore && (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggle(key)}
                            title={expanded ? "收起" : "看全文"}
                            className="mt-0.5 block w-full text-left text-micro leading-snug text-l3 hover:text-l2"
                          >
                            {quote && <span className={`block break-words ${expanded ? "" : "line-clamp-1"}`}>{quote}</span>}
                            {item.evidence?.detail && (
                              <span className={`block break-words ${expanded ? "" : "line-clamp-1"}`}>{item.evidence.detail}</span>
                            )}
                          </button>
                        )}
                      </div>
                      {item.status !== "passed" && (onAddNote || onConsult) && (
                        <div className="flex shrink-0 items-start gap-1 pt-px">
                          {/* Mesa 核对的是数得清的事，不必请几家研讨 */}
                          {onConsult && item.status === "needs_human" && item.checker !== "mesa" && (
                            <button
                              type="button"
                              onClick={() => onConsult(item)}
                              title="拿不准时请几家不同模型的 AI 只读看看这一处，各给意见、再互相补充；判断仍由你定"
                              className="rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                            >
                              请几家研讨
                            </button>
                          )}
                          {onAddNote && (
                            <button
                              type="button"
                              disabled={noted}
                              onClick={() => onAddNote(item)}
                              title={noted ? "已经在右边的意见栏里" : "写成一句修改意见，加到右边的意见栏；退回时交给 AI 照着改"}
                              className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:cursor-default disabled:border-transparent disabled:text-l4"
                            >
                              {noted ? "已加入" : "加进意见"}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      {children && <div className="px-2">{children}</div>}
      {checks.skipped > 0 && (
        <p className="px-2 text-micro text-warn-text">另有 {checks.skipped} 行核验记录读不懂，没有列出</p>
      )}
      <p className="mt-1 px-2 text-micro text-l4">{CHECK_DISCLAIMER}</p>
    </section>
  );
}
