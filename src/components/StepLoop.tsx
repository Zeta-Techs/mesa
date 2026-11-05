/** 综述回路二期的两块界面（docs/design-review-loop.md §4、§6）：
 *  - ReworkDialog：补料单表单。只收字段，发出（恢复 / 并入 / 写单 / 开对话）由 TaskCardsSection 编排。
 *  - StepRoundsSection：「这一步的几轮」，只读——看每一轮带回了哪些文件、和上一轮比，不提供回到旧一轮（§13-5）。 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { fieldClass, InlineNotice, primaryActionClass, secondaryActionClass } from "./PageFrame";
import {
  parseTopics,
  roundCauseLabel,
  roundTime,
  type RoundTextDto,
  type StepRoundDto,
  type StepRoundsDto,
} from "../step-loop";

export interface ReworkFields {
  target: string;
  topics: string[];
  reason: string;
  clues: string;
  scale: number | null;
}

export function ReworkDialog({
  fromStep,
  targets,
  prefill = {},
  busy,
  error,
  onCancel,
  onSend,
}: {
  fromStep: string;
  /** 可退回的上游步骤名，近的在前 */
  targets: string[];
  /** 按退回目标预填的主题与原因（大纲「覆盖检查」里的薄节，三期 §9.3）；人改过就不再覆盖 */
  prefill?: Record<string, { topics: string; reason: string }>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSend: (fields: ReworkFields) => void;
}) {
  const first = targets.find((t) => prefill[t]) ?? targets[0] ?? "";
  const [target, setTarget] = useState(first);
  const [topics, setTopics] = useState(prefill[first]?.topics ?? "");
  const [reason, setReason] = useState(prefill[first]?.reason ?? "");
  const [edited, setEdited] = useState(false);
  const pickTarget = (next: string) => {
    setTarget(next);
    if (!edited) {
      setTopics(prefill[next]?.topics ?? "");
      setReason(prefill[next]?.reason ?? "");
    }
  };
  const [clues, setClues] = useState("");
  const [scale, setScale] = useState("");
  const parsed = parseTopics(topics);
  const ready = !!target && parsed.length > 0 && reason.trim().length > 0 && !busy;
  const scaleNum = Number.parseInt(scale, 10);
  return (
    <Modal
      open
      size="md"
      layer="overlay"
      title="退回上一步补料"
      description={`从「${fromStep}」退回。AI 只补你列的这些，已有的不重做；做完照常去评审、保存进项目，之后这一步再点「跟进上游的新增」接上。`}
      dismissOnBackdrop={!busy}
      onClose={() => {
        if (!busy) onCancel();
      }}
      footer={
        <>
          <button type="button" className={secondaryActionClass} disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={!ready}
            onClick={() =>
              onSend({
                target,
                topics: parsed,
                reason: reason.trim(),
                clues: clues.trim(),
                scale: Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
              })
            }
          >
            {busy ? "正在交给上一步…" : "退回去补"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-l3">
        {targets.length > 1 && (
          <label className="block space-y-1">
            <span>退回到</span>
            <select className={fieldClass} value={target} onChange={(e) => pickTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                  {prefill[t] ? "（大纲覆盖检查里有要补的）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span>要补的主题或章节（一行一条）</span>
          <textarea
            className={`${fieldClass} min-h-20 resize-y`}
            value={topics}
            onChange={(e) => {
              setEdited(true);
              setTopics(e.target.value);
            }}
            placeholder={"例：§3.2 催化剂失活机理：近三年原位表征工作"}
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span>为什么要补（一句话）</span>
          <input
            className={fieldClass}
            value={reason}
            onChange={(e) => {
              setEdited(true);
              setReason(e.target.value);
            }}
            placeholder="例：这一节能写进正文的只有 2 篇，而且都早于 2021 年"
          />
        </label>
        <label className="block space-y-1">
          <span>线索（可选）：关键词、已知的几篇、不要的方向</span>
          <textarea
            className={`${fieldClass} min-h-12 resize-y`}
            value={clues}
            onChange={(e) => setClues(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span>大致补多少篇（可选）</span>
          <input
            className={`${fieldClass} w-28`}
            inputMode="numeric"
            value={scale}
            onChange={(e) => setScale(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="不填按需要"
          />
        </label>
        {error && <InlineNotice>{error}</InlineNotice>}
      </div>
    </Modal>
  );
}

/** 「这一步的几轮」：折叠的一行，展开列每一轮；点一轮看它带回的文件，可和上一轮比。 */
export function StepRoundsSection({
  projectPath,
  workspaceId,
  refreshKey,
}: {
  projectPath: string;
  workspaceId: string;
  /** 步骤状态变了就重读（保存进项目后多一轮） */
  refreshKey: string;
}) {
  const [data, setData] = useState<StepRoundsDto | null>(null);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<StepRoundDto | null>(null);
  useEffect(() => {
    let stale = false;
    invoke<StepRoundsDto>("step_rounds", { root: projectPath, workspaceId })
      .then((d) => {
        if (!stale) setData(d);
      })
      .catch(() => {
        if (!stale) setData(null);
      });
    return () => {
      stale = true;
    };
  }, [projectPath, workspaceId, refreshKey]);
  // 只保存过一次、也没开新一轮时不出：一轮没什么可比的
  if (!data || (data.rounds.length < 2 && !data.openCause)) return null;
  const rounds = [...data.rounds].reverse();
  return (
    <div className="mt-1 pl-9 text-micro text-l4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:text-l2"
        title="每次保存进项目算一轮：看每一轮带回了哪些文件、和上一轮比改了什么"
      >
        {open ? "▾" : "▸"} 这一步做过 {data.rounds.length} 轮
        {data.openCause ? ` · 第 ${data.rounds.length + 1} 轮（${roundCauseLabel(data.openCause)}）还没保存` : ""}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {rounds.map((r) => (
            <li key={r.index} className="flex items-center gap-2 tabular-nums">
              <span className="text-l3">第 {r.index} 轮</span>
              <span>{roundTime(r.savedAt)}</span>
              <span title={r.rework ? `补：${r.rework.topics.join("；")}\n为什么：${r.rework.reason}` : undefined}>
                {roundCauseLabel(r.cause)}
                {r.rework ? `（${r.rework.fromStep} 退回）` : ""}
              </span>
              <span>{r.paths.length} 个文件</span>
              {r.sha && r.paths.length > 0 && (
                <button
                  type="button"
                  onClick={() => setViewing(r)}
                  className="text-l3 underline decoration-dotted underline-offset-2 hover:text-l1"
                >
                  看这一轮
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {viewing && (
        <RoundViewer
          projectPath={projectPath}
          round={viewing}
          previous={data.rounds.find((r) => r.index === viewing.index - 1) ?? null}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function RoundViewer({
  projectPath,
  round,
  previous,
  onClose,
}: {
  projectPath: string;
  round: StepRoundDto;
  previous: StepRoundDto | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState(round.paths[0] ?? "");
  const canCompare = !!previous?.sha;
  const [mode, setMode] = useState<"diff" | "file">(canCompare ? "diff" : "file");
  const [body, setBody] = useState<RoundTextDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let stale = false;
    setBody(null);
    setError(null);
    const req =
      mode === "diff" && previous?.sha
        ? invoke<RoundTextDto>("step_round_diff", { root: projectPath, from: previous.sha, to: round.sha, path })
        : invoke<RoundTextDto>("step_round_file", { root: projectPath, sha: round.sha, path });
    req
      .then((t) => {
        if (!stale) setBody(t);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [projectPath, round.sha, previous?.sha, path, mode]);
  return (
    <Modal
      open
      size="lg"
      layer="overlay"
      title={`第 ${round.index} 轮 · ${roundTime(round.savedAt)} · ${roundCauseLabel(round.cause)}`}
      description="只读：这一轮保存进项目时的版本。要用旧版本里的内容，从这里复制。"
      onClose={onClose}
    >
      <div className="flex min-h-[50vh] gap-3 text-xs">
        <ul className="w-56 shrink-0 space-y-0.5 overflow-y-auto">
          {round.paths.map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => setPath(p)}
                className={`w-full truncate rounded-sm px-1.5 py-0.5 text-left ${
                  p === path ? "bg-hover text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                }`}
                title={p}
              >
                {p}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-1">
            <button
              type="button"
              disabled={!canCompare}
              onClick={() => setMode("diff")}
              title={canCompare ? `和第 ${previous?.index} 轮比` : "这是第一轮，没有上一轮可比"}
              className={`rounded-sm px-1.5 py-0.5 disabled:opacity-40 ${mode === "diff" ? "bg-hover text-l1" : "text-l3 hover:text-l1"}`}
            >
              和上一轮比
            </button>
            <button
              type="button"
              onClick={() => setMode("file")}
              className={`rounded-sm px-1.5 py-0.5 ${mode === "file" ? "bg-hover text-l1" : "text-l3 hover:text-l1"}`}
            >
              看这一版
            </button>
          </div>
          {error ? (
            <InlineNotice>{error}</InlineNotice>
          ) : !body ? (
            <p className="text-l4">读取中…</p>
          ) : mode === "diff" && !body.text.trim() ? (
            <p className="text-l4">这个文件和上一轮一样。</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-micro text-l2">
              {mode === "diff"
                ? body.text.split("\n").map((line, i) => (
                    <span
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "block text-add"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "block text-del"
                            : line.startsWith("@@")
                              ? "block text-l4"
                              : "block"
                      }
                    >
                      {line || " "}
                    </span>
                  ))
                : body.text}
              {body.truncated && "\n…（太长，只显示前 512 KB）"}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  );
}
