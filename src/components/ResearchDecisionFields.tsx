import { useEffect, useRef, useState } from "react";
import {
  DECISION_STATUS,
  DECISION_STATUS_ASK,
  decisionAsk,
  formatDecisionAnswer,
  parseDecisionRecords,
  setDecisionAnswer,
  type DecisionStatus,
} from "../step-decisions";
import type { StepDecisionDto } from "../types";
import { InlineNotice } from "./PageFrame";

const STATUSES = Object.keys(DECISION_STATUS) as DecisionStatus[];

type Draft = { status: DecisionStatus | ""; note: string; legacy: boolean };

function draftsFrom(text: string, decisions: StepDecisionDto[]): Record<string, Draft> {
  const records = parseDecisionRecords(text);
  return Object.fromEntries(decisions.map((d) => {
    const q = d.q.trim();
    const record = records.get(q);
    return [q, {
      status: record && record.status !== "legacy" ? record.status : "",
      note: record?.note ?? "",
      legacy: record?.status === "legacy",
    }];
  }));
}

export default function ResearchDecisionFields({ decisions, text, disabled, evidenceRevision = null, onChange }: {
  decisions: StepDecisionDto[]; text: string; disabled?: boolean; evidenceRevision?: string | null; onChange: (text: string) => void;
}) {
  const [drafts, setDrafts] = useState(() => draftsFrom(text, decisions));
  const sent = useRef(text);
  useEffect(() => {
    if (text !== sent.current) {
      sent.current = text;
      setDrafts(draftsFrom(text, decisions));
    }
  }, [text, decisions]);
  if (!decisions.length) return null;
  function commit(question: string, status: DecisionStatus | "", note: string, legacy = false) {
    const q = question.trim();
    setDrafts((old) => ({ ...old, [q]: { status, note, legacy } }));
    const value = status && note.trim() ? formatDecisionAnswer(status, note.trim(), evidenceRevision) : "";
    sent.current = setDecisionAnswer(sent.current, question, value);
    onChange(sent.current);
  }
  return <fieldset disabled={disabled} className="mb-3 space-y-2 rounded-md ccode-well p-3 text-xs">
    <legend className="px-1 font-medium text-l1">你的决定</legend>
    <p className="text-micro text-l4">先选能不能写，再写一句范围。证据还不够或先别做，不能开工。</p>
    {decisions.map((decision) => {
      const q = decision.q.trim();
      const draft = drafts[q] ?? { status: "" as const, note: "", legacy: false };
      const records = parseDecisionRecords(sent.current);
      const record = records.get(q);
      const stale = draft.legacy || (evidenceRevision && record && (record.status === "approve" || record.status === "prepare") && record.boundRevision !== evidenceRevision);
      return <div key={decision.q} className="space-y-1 text-l2">
        <span className="mb-1 block" title={decision.q}>{decisionAsk(decision.q)}</span>
        <label className="block">能不能写
          <select value={draft.status} onChange={(e) => commit(decision.q, e.target.value as DecisionStatus | "", draft.note)}
            className="mt-1 w-full rounded border border-field bg-canvas px-2 py-1 text-xs text-l1 disabled:opacity-50">
            <option value="">未选择</option>
            {STATUSES.map((key) => <option key={key} value={key}>{DECISION_STATUS_ASK[key]}</option>)}
          </select>
        </label>
        <label className="block">范围
          <input value={draft.note} onChange={(e) => commit(decision.q, draft.status, e.target.value, false)}
            placeholder="例如：按已精读笔记写，没全文的只写到摘要"
            className="w-full rounded border border-field bg-canvas px-2 py-1 text-xs text-l1 disabled:opacity-50" />
        </label>
        {stale && <InlineNotice tone="warn" size="micro">{draft.legacy ? "这是旧的纯文本记录，请重新选择状态，不会自动视为已批准。" : "依据版本已变化，需要重新确认。"}</InlineNotice>}
      </div>;
    })}
  </fieldset>;
}
