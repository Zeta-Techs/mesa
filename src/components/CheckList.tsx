import { useState } from "react";
import {
  CHECK_DISCLAIMER,
  CHECK_STATUS_LABEL,
  checkLocation,
  checkQuoteLine,
  groupChecks,
  type CheckStatus,
  type ChecksDto,
} from "../research-checks";

const STATUS_TONE: Record<CheckStatus, string> = {
  blocked: "text-err-text",
  needs_human: "text-warn-text",
  passed: "text-l3",
};

/** 评审页「基础检查」行展开的核验清单：按 拦下 / 待你判断 / 通过 分组，通过默认收起 */
export default function CheckList({ checks }: { checks: ChecksDto }) {
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
      {checks.skipped > 0 && (
        <p className="text-micro text-warn-text">另有 {checks.skipped} 行核验记录读不懂，没有列出</p>
      )}
      <p className="text-micro text-l4">{CHECK_DISCLAIMER}</p>
    </section>
  );
}
