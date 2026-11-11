/** 综述回路二期的两块界面（docs/design-review-loop.md §4、§6）：
 *  - ReworkDialog：补料单表单。只收字段，发出（恢复 / 并入 / 写单 / 开对话）由 TaskCardsSection 编排。
 *  - StepRoundsSection：「这一步的几轮」，只读——看每一轮带回了哪些文件、和上一轮比，不提供回到旧一轮（§13-5）。 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import { fieldClass, InlineNotice, primaryActionClass, secondaryActionClass } from "./PageFrame";
import {
  isLedgerFile,
  litOrder,
  parseTopics,
  readableDiff,
  roundCauseLabel,
  roundChangeLabel,
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
  /** 补文献单上「精读已有的」那几条，随退回检索的单子交给链上的精读（按大纲的节转回路①）；其余情况为空 */
  reads: string[];
}

/** 下拉里「补文献」这一项的值：检索、精读两步并成一项，按两栏分派（按大纲的节转回路①） */
const LIT = "\u0000lit";

export function ReworkDialog({
  fromStep,
  targets,
  prefill = {},
  unplaced = [],
  searchTarget,
  notesTarget,
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
  /** 上游里找文献、读文献的步骤（lit-search / lit-notes 槽，最近的那个）：两步并成下拉里的「补文献」，分「找新文献 / 精读已有的」两栏 */
  searchTarget?: string;
  notesTarget?: string;
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
  const isLit = (t: string) => t === searchTarget || t === notesTarget;
  // 下拉：检索、精读并成一项「补文献」，放在两者里靠前那个的位置；其余步骤照旧一项一步
  const options = targets.reduce<string[]>((acc, t) => {
    const v = isLit(t) ? LIT : t;
    return acc.includes(v) ? acc : [...acc, v];
  }, []);
  const litPrefill = (searchTarget && prefill[searchTarget]) || (notesTarget && prefill[notesTarget]);
  const first =
    (initial && targets.includes(initial.target) ? (isLit(initial.target) ? LIT : initial.target) : null) ??
    (litPrefill ? LIT : null) ??
    options.find((t) => prefill[t]) ??
    options[0] ??
    "";
  const [mode, setMode] = useState(first);
  const lit = mode === LIT;
  const litReason = [searchTarget && prefill[searchTarget]?.reason, notesTarget && prefill[notesTarget]?.reason].filter(Boolean).join("；");
  const [searchText, setSearchText] = useState(
    initial ? (initial.target === searchTarget ? initial.topics : "") : (searchTarget && prefill[searchTarget]?.topics) || "",
  );
  const [readText, setReadText] = useState(
    initial ? (initial.target === notesTarget ? initial.topics : "") : (notesTarget && prefill[notesTarget]?.topics) || "",
  );
  // 非文献步骤（修改单）只有一栏
  const [topics, setTopics] = useState(initial && !isLit(initial.target) ? initial.topics : first !== LIT ? (prefill[first]?.topics ?? "") : "");
  const [reason, setReason] = useState(initial?.reason ?? (first === LIT ? litReason : (prefill[first]?.reason ?? "")));
  const [edited, setEdited] = useState(!!initial);
  const searchRows = parseTopics(searchText);
  const readRows = parseTopics(readText);
  // 补文献时这张单子实际退回哪一步：有找新文献就是检索，否则精读
  const litTarget = searchTarget && (searchRows.length > 0 || !notesTarget) ? searchTarget : (notesTarget ?? "");
  const target = lit ? litTarget : mode;
  // 两栏都写了：精读那几条靠链交过去，链上必须有精读
  const notesLocked = lit && !!searchTarget && !!notesTarget && searchRows.length > 0 && readRows.length > 0;
  const chainFor = (t: string) => {
    const list = chainOptions[t] ?? [];
    return notesLocked && t === searchTarget && notesTarget && !list.includes(notesTarget) ? [notesTarget, ...list] : list;
  };
  const chainDefault = (t: string) => (chainOptions[t] ?? []).filter((st) => !chainOff.includes(st));
  const [chain, setChain] = useState<string[]>(chainDefault(first === LIT ? litTarget : first));
  // 补文献栏从「只精读」变成「也找新的」（或反过来）时，退回目标跟着换，链按新目标重给默认
  const [chainOf, setChainOf] = useState(target);
  if (chainOf !== target) {
    setChainOf(target);
    setChain(chainDefault(target));
  }
  const pickMode = (next: string) => {
    setMode(next);
    if (!edited) {
      if (next === LIT) {
        setReason(litReason);
      } else {
        setTopics(prefill[next]?.topics ?? "");
        setReason(prefill[next]?.reason ?? "");
      }
    }
  };
  const [clues, setClues] = useState(initial?.clues ?? "");
  const [scale, setScale] = useState(initial?.scale ? String(initial.scale) : "");
  const parsed = parseTopics(topics);
  const order = lit
    ? litOrder({ search: searchTarget, notes: notesTarget, searchRows, readRows, chainOptions, picked: chain })
    : null;
  const ready = (lit ? !!order : !!target && parsed.length > 0) && reason.trim().length > 0 && !busy;
  const scaleNum = Number.parseInt(scale, 10);
  const searching = lit && !!searchTarget;
  const chainList = chainFor(target);
  return (
    <Modal
      open
      size="md"
      layer="overlay"
      title={lit ? "补文献" : "退回上一步修改"}
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
            onClick={() => {
              const base = { reason: reason.trim(), clues: clues.trim() };
              if (order) {
                onSend({
                  ...base,
                  ...order,
                  scale: order.target === searchTarget && Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : null,
                });
                return;
              }
              onSend({
                ...base,
                target,
                topics: parsed,
                scale: null,
                // 按步骤顺序，只留现在这个目标下列得出来的
                chain: (chainOptions[target] ?? []).filter((st) => chain.includes(st)),
                reads: [],
              });
            }}
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
            要补的话抄进下面对应的一栏。
          </InlineNotice>
        )}
        {options.length > 1 && (
          <label className="block space-y-1">
            <span>退回到</span>
            <select className={fieldClass} value={mode} onChange={(e) => pickMode(e.target.value)}>
              {options.map((t) => (
                <option key={t} value={t}>
                  {t === LIT ? "补文献（找新文献 / 精读已有的）" : t}
                  {(t === LIT ? litPrefill : prefill[t]) ? "（大纲覆盖检查里有要补的）" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {lit ? (
          <>
            {searchTarget && (
              <label className="block space-y-1">
                <span>找新文献（交给「{searchTarget}」）：为哪一节找、找什么，一行一条</span>
                <textarea
                  className={`${fieldClass} min-h-16 resize-y`}
                  value={searchText}
                  onChange={(e) => {
                    setEdited(true);
                    setSearchText(e.target.value);
                  }}
                  placeholder="例：4.3：2024 年以后界面稳定性的高电流工作"
                  autoFocus={!readText}
                />
              </label>
            )}
            {notesTarget && (
              <label className="block space-y-1">
                <span>精读已有的（交给「{notesTarget}」）：节和要精读的篇，一行一条</span>
                <textarea
                  className={`${fieldClass} min-h-16 resize-y`}
                  value={readText}
                  onChange={(e) => {
                    setEdited(true);
                    setReadText(e.target.value);
                  }}
                  placeholder="例：4.3：[@Su2025] [@Xu2019]"
                  autoFocus={!!readText && !searchText}
                />
              </label>
            )}
            {notesLocked && (
              <p className="text-micro text-l4">
                先交给「{searchTarget}」找，保存进项目后「{notesTarget}」把新纳入的和要精读的这几条一起读。
              </p>
            )}
          </>
        ) : (
          <label className="block space-y-1">
            <span>要改的地方（一行一条）</span>
            <textarea
              className={`${fieldClass} min-h-20 resize-y`}
              value={topics}
              onChange={(e) => {
                setEdited(true);
                setTopics(e.target.value);
              }}
              placeholder="例：§3 先讲机理、再讲材料体系"
              autoFocus
            />
          </label>
        )}
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
        {searching && (
          <label className="block space-y-1">
            <span>找新文献大致补多少篇（可选）</span>
            <input
              className={`${fieldClass} w-28`}
              inputMode="numeric"
              value={scale}
              onChange={(e) => setScale(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="不填按需要"
            />
          </label>
        )}
        {chainList.length > 0 && (
          <fieldset className="space-y-1">
            <legend>{lit ? "补" : "改"}完、保存进项目后，接着自动跟进</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {chainList.map((st) => {
                const locked = notesLocked && st === notesTarget;
                return (
                  <label key={st} className="inline-flex items-center gap-1 text-l2">
                    <input
                      type="checkbox"
                      checked={locked || chain.includes(st)}
                      disabled={locked}
                      onChange={(e) => setChain((cur) => (e.target.checked ? [...cur, st] : cur.filter((x) => x !== st)))}
                    />
                    {st}
                    {locked && <span className="text-l4">（要精读的几条在这一步做）</span>}
                    {!locked && chainOff.includes(st) && <span className="text-l4">（会重跑实验，默认不勾）</span>}
                  </label>
                );
              })}
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
  /** 文献台账比上一轮：一句白话（「新加 2 篇：…；移出 1 篇：…」）；null = 比不出，退回逐行 */
  const [ledger, setLedger] = useState<string | null>(null);
  const ledgerMode = mode === "diff" && !!previous?.sha && isLedgerFile(path);
  useEffect(() => {
    if (!ledgerMode) {
      setLedger(null);
      return;
    }
    let stale = false;
    invoke<string | null>("step_round_ledger", { root: projectPath, from: previous?.sha ?? null, to: round.sha })
      .then((t) => !stale && setLedger(t))
      .catch(() => !stale && setLedger(null));
    return () => {
      stale = true;
    };
  }, [ledgerMode, projectPath, previous?.sha, round.sha]);
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
          {round.paths.map((p, i) => {
            const tag = roundChangeLabel(round.changes?.[i]);
            return (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => setPath(p)}
                  className={`flex w-full min-w-0 items-baseline gap-1.5 rounded-sm px-1.5 py-0.5 text-left ${
                    p === path ? "bg-hover text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                  }`}
                  title={p}
                >
                  {tag && (
                    <span className={`shrink-0 text-micro ${tag === "新加" ? "text-add" : tag === "删了" ? "text-del" : "text-l4"}`}>{tag}</span>
                  )}
                  <span className="min-w-0 truncate">{p}</span>
                </button>
              </li>
            );
          })}
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
          {ledgerMode && ledger ? (
            <div className="space-y-1.5 rounded-sm bg-inset p-3 text-l2">
              <p className="leading-relaxed">{ledger}</p>
              {path !== "papers/included.json" && <p className="text-micro text-l4">这份由纳入清单生成，跟着它变。原文点「看这一版」。</p>}
            </div>
          ) : error ? (
            <InlineNotice>{error}</InlineNotice>
          ) : !body ? (
            <p className="text-l4">读取中…</p>
          ) : mode === "diff" && !body.text.trim() ? (
            <p className="text-l4">这个文件和上一轮一样。</p>
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-inset p-2 font-mono text-micro text-l2">
              {mode === "diff"
                ? readableDiff(body.text).map((line, i) =>
                    line.kind === "gap" ? (
                      <span key={i} aria-hidden="true" className="my-1 block text-l4">
                        ⋯
                      </span>
                    ) : (
                      <span
                        key={i}
                        className={
                          line.kind === "add" ? "block bg-add/10 text-add" : line.kind === "del" ? "block bg-del/10 text-del" : "block"
                        }
                      >
                        {line.text || " "}
                      </span>
                    ),
                  )
                : body.text}
              {body.truncated && "\n…（太长，只显示前 512 KB）"}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  );
}
