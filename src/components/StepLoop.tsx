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
  /** 补完、保存进项目后接着自动跟进的下游步骤（补料链，2026-11-06 流程贯通 §6） */
  chain: string[];
}

export function ReworkDialog({
  fromStep,
  targets,
  prefill = {},
  unplaced = [],
  litTargets = [],
  initial,
  fromInProgress = false,
  fromPending = false,
  chainOptions = {},
  chainOff = [],
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
  /** 覆盖检查里归不到退回目标的薄节（建议没写补检 / 补读）：单列提示，人自己决定抄进哪一步 */
  unplaced?: string[];
  /** 退回目标里找文献 / 读文献的步骤（检索、精读）：退回它们叫「补料」、问篇数；退回大纲、初稿这类叫「修改」（2026-11-06） */
  litTargets?: string[];
  /** 整张单子预填（项目助手起草的补料单，2026-11-06）：给了就不按 prefill 换主题 */
  initial?: { target: string; topics: string; reason: string; clues: string; scale: number | null };
  /** 发起的这一步还没保存（做到一半 / 待评审，2026-11-06 流程贯通 §5）：说明它之后怎么接上补来的 */
  fromInProgress?: boolean;
  /** 发起的这一步还没开工（定稿前更新检索，2026-11-07）：补完、跟进完再开始它 */
  fromPending?: boolean;
  /** 按退回目标列出补完后能接着自动跟进的下游步骤（目标之后、已保存的步骤，按顺序）；默认全勾 */
  chainOptions?: Record<string, string[]>;
  /** 链上默认不勾的步骤（重跑实验花时间、花算力，step-kind.ts chainDefaultOff）：列出来但要人自己勾 */
  chainOff?: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSend: (fields: ReworkFields) => void;
}) {
  const first = (initial && targets.includes(initial.target) ? initial.target : null) ?? targets.find((t) => prefill[t]) ?? targets[0] ?? "";
  const [target, setTarget] = useState(first);
  const [topics, setTopics] = useState(initial?.topics ?? prefill[first]?.topics ?? "");
  const [reason, setReason] = useState(initial?.reason ?? prefill[first]?.reason ?? "");
  const [edited, setEdited] = useState(!!initial);
  const chainDefault = (t: string) => (chainOptions[t] ?? []).filter((st) => !chainOff.includes(st));
  const [chain, setChain] = useState<string[]>(chainDefault(first));
  const pickTarget = (next: string) => {
    setTarget(next);
    setChain(chainDefault(next));
    if (!edited) {
      setTopics(prefill[next]?.topics ?? "");
      setReason(prefill[next]?.reason ?? "");
    }
  };
  const [clues, setClues] = useState(initial?.clues ?? "");
  const [scale, setScale] = useState(initial?.scale ? String(initial.scale) : "");
  const parsed = parseTopics(topics);
  const ready = !!target && parsed.length > 0 && reason.trim().length > 0 && !busy;
  const scaleNum = Number.parseInt(scale, 10);
  const lit = litTargets.includes(target);
  return (
    <Modal
      open
      size="md"
      layer="overlay"
      title={lit ? "补充文献" : "退回上一步修改"}
      description={
        (lit
          ? `从「${fromStep}」退回。AI 只补你列的这些，已有的不重做；做完照常去评审、保存进项目，`
          : `从「${fromStep}」退回。AI 只改你列的这些，你确认过的内容不推翻；做完照常去评审、保存进项目，`) +
        (fromPending
          ? `下面勾上的步骤跟进完、保存进项目后，再开始「${fromStep}」，它开工时用的就是更新后的内容。`
          : fromInProgress
            ? `之后在「${fromStep}」点「继续」，会先把${lit ? "补" : "改"}来的并进来再接着做（这一步不用先保存）。`
            : `之后「${fromStep}」再点「跟进更新」接上。`)
      }
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
                scale: lit && Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
                // 按步骤顺序，只留现在这个目标下列得出来的
                chain: (chainOptions[target] ?? []).filter((st) => chain.includes(st)),
              })
            }
          >
            {busy ? "正在交给上一步…" : lit ? "退回去补" : "退回去改"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-l3">
        {unplaced.length > 0 && (
          <InlineNotice tone="info">
            大纲覆盖检查里还有 {unplaced.length} 节是薄的，但建议没写「补检」或「补读」，没法自动归到哪一步：
            {unplaced.map((u) => (
              <span key={u} className="block">
                · {u}
              </span>
            ))}
            要补的话选好退回到哪一步，抄进下面的主题里。
          </InlineNotice>
        )}
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
          <span>{lit ? "要补的主题或章节（一行一条）" : "要改的地方（一行一条）"}</span>
          <textarea
            className={`${fieldClass} min-h-20 resize-y`}
            value={topics}
            onChange={(e) => {
              setEdited(true);
              setTopics(e.target.value);
            }}
            placeholder={lit ? "例：§3.2 催化剂失活机理：近三年原位表征工作" : "例：§3 先讲机理、再讲材料体系"}
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span>{lit ? "为什么要补（一句话）" : "为什么要改（一句话）"}</span>
          <input
            className={fieldClass}
            value={reason}
            onChange={(e) => {
              setEdited(true);
              setReason(e.target.value);
            }}
            placeholder={
              lit ? "例：这一节能写进正文的只有 2 篇，而且都早于 2021 年" : "例：写初稿时发现先讲材料，读者看不出各体系为什么这样设计"
            }
          />
        </label>
        <label className="block space-y-1">
          <span>{lit ? "线索（可选）：关键词、已知的几篇、要顺着找的综述、不要的方向" : "参考（可选）：相关的文件、段落，或你希望的改法"}</span>
          <textarea
            className={`${fieldClass} min-h-12 resize-y`}
            value={clues}
            onChange={(e) => setClues(e.target.value)}
          />
        </label>
        {lit && (
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
        )}
        {(chainOptions[target] ?? []).length > 0 && (
          <fieldset className="space-y-1">
            <legend>{lit ? "补" : "改"}完、保存进项目后，接着自动跟进</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {(chainOptions[target] ?? []).map((st) => (
                <label key={st} className="inline-flex items-center gap-1 text-l2">
                  <input
                    type="checkbox"
                    checked={chain.includes(st)}
                    onChange={(e) => setChain((cur) => (e.target.checked ? [...cur, st] : cur.filter((x) => x !== st)))}
                  />
                  {st}
                  {chainOff.includes(st) && <span className="text-l4">（会重跑实验，默认不勾）</span>}
                </label>
              ))}
            </div>
            <p className="text-micro text-l4">
              上一步保存后，下一步自动开「跟进更新」，只处理新增的部分；每一步照旧要你评审、保存。不勾的到时自己点跟进。
            </p>
          </fieldset>
        )}
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
