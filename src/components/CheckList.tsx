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

/** 评审页「基础检查」行展开的核验清单：按 拦下 / 待你判断 / 通过 分组，通过默认收起 */
export default function CheckList({
  checks,
  onConsult,
  onAddNote,
  children,
}: {
  checks: ChecksDto;
  /** 待你判断的一条「请几家研讨这一条」（研讨二期）；不给就不出按钮 */
  onConsult?: (item: CheckItem) => void;
  /** 拦下 / 待你判断的一条加进退回意见（2026-11-11 评审页意见栏）；不给就不出按钮 */
  onAddNote?: (item: CheckItem) => void;
  /** 列表下面、说明上面挂的一块（大纲：覆盖检查对照） */
  children?: ReactNode;
}) {
  const [showPassed, setShowPassed] = useState(false);
  const groups = groupChecks(checks.items);
  return (
    <section aria-label="核验清单" className="mt-1.5 border-t border-hairline pt-1.5">
      {groups.map((group) => {
        const collapsed = group.status === "passed" && !showPassed;
        return (
          <div key={group.status} className="mb-1.5">
            <button
              type="button"
              disabled={group.status !== "passed"}
              aria-expanded={group.status === "passed" ? showPassed : undefined}
              onClick={() => setShowPassed((v) => !v)}
              className={`text-micro ${STATUS_TONE[group.status]} ${group.status === "passed" ? "hover:text-l1" : "cursor-default"}`}
            >
              {CHECK_STATUS_LABEL[group.status]}（{group.items.length}）
              {group.status === "passed" && (showPassed ? " 收起" : " 展开")}
            </button>
            {!collapsed && (
              <ul className="mt-0.5 space-y-1">
                {group.items.map((item) => {
                  const where = checkLocation(item);
                  const quote = checkQuoteLine(item);
                  return (
                    <li key={`${item.id}-${where}`} className="text-micro leading-snug">
                      <span className={STATUS_TONE[item.status]}>{item.title}</span>
                      {where && <span className="ml-1.5 font-mono text-l4">{where}</span>}
                      <span
                        className="ml-1.5 text-l4"
                        title={item.checker === "mesa" ? "Mesa 自己按文件数出来的，不经 AI" : undefined}
                      >
                        {checkSourceLabel(item)}
                      </span>
                      {onAddNote && item.status !== "passed" && (
                        <button
                          type="button"
                          onClick={() => onAddNote(item)}
                          title="把这一条写成一句修改意见，加到右边的意见栏；退回时交给 AI 照着改"
                          className="ml-1.5 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1"
                        >
                          <span className="text-micro">加进意见</span>
                        </button>
                      )}
                      {/* Mesa 核对的是数得清的事，不必请几家研讨 */}
                      {onConsult && item.status === "needs_human" && item.checker !== "mesa" && (
                        <button
                          type="button"
                          onClick={() => onConsult(item)}
                          title="拿不准时请几家不同模型的 AI 只读看看这一处，各给意见、再互相补充；判断仍由你定"
                          className="ml-1.5 rounded-sm px-1 text-l3 hover:bg-hover hover:text-l1"
                        >
                          <span className="text-micro">请几家研讨这一条</span>
                        </button>
                      )}
                      {quote && <p className="mt-0.5 break-words text-l3">{quote}</p>}
                      {item.evidence?.detail && <p className="break-words text-l4">{item.evidence.detail}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
      {children}
      {checks.skipped > 0 && (
        <p className="text-micro text-warn-text">另有 {checks.skipped} 行核验记录读不懂，没有列出</p>
      )}
      <p className="text-micro text-l4">{CHECK_DISCLAIMER}</p>
    </section>
  );
}
