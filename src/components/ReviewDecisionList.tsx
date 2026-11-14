import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readResearchFile } from "../research-report-load";
import { researchAbsolutePath } from "../research-report";
import {
  applyReportVerdict,
  applyVerifyVerdict,
  decisionCandidatePaths,
  inlineDecisionLine,
  itemSuggestion,
  parseReviewItems,
  reviewItemSummary,
  tokenizeDecisionSummary,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewVerdict,
} from "../review-decisions";
import type { ProjectFilePaneFile } from "../project-file-pane";
import { InlineNotice } from "./PageFrame";
import { usePolling } from "../polling";

export interface ReviewDecisionOpenFileReq {
  path: string;
  root: string;
  name: string;
  rel: string;
  line?: number;
  showList?: boolean;
  list: ProjectFilePaneFile[];
}

interface ResolvedDecisionFile {
  path: string;
  root: string;
  name: string;
  rel: string;
}

async function resolveExistingInRoots(
  roots: string[],
  candidates: string[],
): Promise<Map<string, { abs: string; root: string }>> {
  const hit = new Map<string, { abs: string; root: string }>();
  let remaining = candidates;
  for (const root of roots) {
    if (remaining.length === 0) break;
    try {
      const found = await invoke<Array<{ path: string; abs: string }>>("existing_files", {
        cwd: root,
        paths: remaining,
      });
      for (const entry of found) {
        if (!hit.has(entry.path)) hit.set(entry.path, { abs: entry.abs, root });
      }
      remaining = remaining.filter((c) => !hit.has(c));
    } catch {
      /* 测试桩或根目录暂不可读时跳过，不阻塞清单渲染 */
    }
  }
  return hit;
}

async function readFirst(roots: string[], rel: string) {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, rel);
      if (!file.truncated) return { root, file };
    } catch {
      /* 试下一处 */
    }
  }
  return null;
}

const VERDICTS: ReviewVerdict[] = ["接受", "拒绝", "修改"];

export default function ReviewDecisionList({
  worktreePath,
  projectRoot,
  target,
  kind,
  onAllDecided,
  onOpenCount,
  onOpenFile,
  onOpenFileInWindow,
  refreshKey,
}: {
  worktreePath?: string | null;
  projectRoot: string;
  target: string;
  kind: ReviewItemKind;
  /** 每条都已决定后，人再点「让 Agent 按决定继续」。 */
  onAllDecided?: () => void;
  /** 还没决定的条数。0 表示可以勾上这一行。 */
  onOpenCount?: (count: number) => void;
  /** 在项目右侧抽屉打开对照文件（带完整涉及文件树 + 可选行号定位）。 */
  onOpenFile?: (req: ReviewDecisionOpenFileReq) => void;
  /** 在独立系统窗口打开对照文件（笔记本窄屏或双屏并排看意见）。 */
  onOpenFileInWindow?: (req: ReviewDecisionOpenFileReq) => void;
  /** 变了就重读文件（步骤的运行状态 / Agent 注意力）：这一行常在文件写出来之前就挂上了 */
  refreshKey?: string;
}) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const rel = target.trim();
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [fileRoot, setFileRoot] = useState(projectRoot);
  const [text, setText] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [resolvedByRaw, setResolvedByRaw] = useState<Map<string, ResolvedDecisionFile>>(() => new Map());
  const [fileList, setFileList] = useState<ProjectFilePaneFile[]>([]);

  async function refreshResolvedFiles(parsed: ReviewItem[], currentRoot: string) {
    const cleanTarget = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const { orderedRaws, candidatesByRaw } = decisionCandidatePaths(parsed, kind, cleanTarget);
    const allCandidates = [...new Set([...candidatesByRaw.values()].flat())];
    const searchRoots = [...new Set([currentRoot, ...roots])];
    const existing = allCandidates.length > 0 ? await resolveExistingInRoots(searchRoots, allCandidates) : new Map();
    if (cleanTarget && !existing.has(cleanTarget)) {
      existing.set(cleanTarget, { abs: researchAbsolutePath(currentRoot, cleanTarget), root: currentRoot });
    }
    const nextByRaw = new Map<string, ResolvedDecisionFile>();
    const nextList: ProjectFilePaneFile[] = [];
    const seenAbs = new Set<string>();
    for (const raw of orderedRaws) {
      const candidates = candidatesByRaw.get(raw) ?? [raw];
      for (const candidate of candidates) {
        const hit = existing.get(candidate);
        if (!hit) continue;
        const name = candidate.split("/").pop() ?? candidate;
        const resolved: ResolvedDecisionFile = {
          path: hit.abs,
          root: hit.root,
          name,
          rel: candidate,
        };
        nextByRaw.set(raw, resolved);
        const dedupKey = hit.abs.replace(/\\/g, "/");
        if (!seenAbs.has(dedupKey)) {
          seenAbs.add(dedupKey);
          nextList.push({ path: hit.abs, root: hit.root, name, rel: candidate });
        }
        break;
      }
    }
    setResolvedByRaw(nextByRaw);
    setFileList(nextList);
  }

  async function load() {
    setError(null);
    if (!rel) {
      setItems([]);
      onOpenCount?.(1);
      setError("这一条没有落点文件。");
      return;
    }
    const found = await readFirst(roots, rel);
    if (!found) {
      // 还没写出来不等于没有条目：不放行勾选（2026-10-24 HER 润色：第一轮后就挂上这一行，
      // 读不到清单显示「没有待核实，勾上跳过」，第二轮写出 9 条后也没再读）
      setItems([]);
      setMissing(true);
      onOpenCount?.(1);
      return;
    }
    setMissing(false);
    setFileRoot(found.root);
    setText(found.file.text);
    setRevision(found.file.revision);
    const parsed = parseReviewItems(found.file.text, kind);
    setItems(parsed);
    onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
    void refreshResolvedFiles(parsed, found.root);
  }

  useEffect(() => {
    void load();
  }, [worktreePath, projectRoot, rel, kind, refreshKey]);

  // 文件还没写出来时隔几秒再看一眼，写出来就停
  usePolling(() => load(), missing ? 5000 : null);

  async function choose(item: ReviewItem, verdict: ReviewVerdict) {
    if (!revision) return;
    // 框里没写就用条目自带的建议改法（灰字那句）
    const note =
      verdict === "修改" ? ((drafts[item.id] ?? item.note).trim() || itemSuggestion(item, kind)) : "";
    if (verdict === "修改" && !note) {
      setError(`${item.id} 选了修改，先写一句要改成什么样。`);
      return;
    }
    setBusyId(item.id);
    setError(null);
    try {
      const next =
        kind === "verify"
          ? applyVerifyVerdict(text, item.id, verdict, note)
          : applyReportVerdict(text, item.id, verdict, note);
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(fileRoot, rel),
        root: fileRoot,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      const parsed = parseReviewItems(next, kind);
      setItems(parsed);
      onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
    } catch (reason) {
      // AI 还在写这份清单时点了决定：版本对不上就重读，不卡在「请重新打开清单」（这一行没有重新打开的入口，2026-11-05 排查）
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await load();
        setError("清单刚被 AI 改过，已重新读取，请再点一次。");
      } else {
        setError(String(reason));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function acceptAll() {
    if (!revision || !items) return;
    const pending = items.filter((item) => item.verdict == null);
    if (pending.length === 0) return;
    setAcceptingAll(true);
    setError(null);
    try {
      let next = text;
      for (const item of pending) {
        next =
          kind === "verify"
            ? applyVerifyVerdict(next, item.id, "接受")
            : applyReportVerdict(next, item.id, "接受");
      }
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(fileRoot, rel),
        root: fileRoot,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      const parsed = parseReviewItems(next, kind);
      setItems(parsed);
      onOpenCount?.(parsed.filter((item) => item.verdict == null).length);
    } catch (reason) {
      if (String(reason).includes("已被 Agent 或其他程序修改")) {
        await load();
        setError("清单刚被 AI 改过，已重新读取，请再点一次。");
      } else {
        setError(String(reason));
      }
    } finally {
      setAcceptingAll(false);
    }
  }

  if (items == null) return <p className="text-micro text-l4">加载条目…</p>;
  if (items.length === 0) {
    return (
      <p className="text-micro text-l4">
        {error ?? inlineDecisionLine(kind, missing ? "missing" : "empty")}
      </p>
    );
  }
  const open = items.filter((item) => item.verdict == null);
  const busy = acceptingAll || busyId != null;

  return (
    <div>
      {error && <InlineNotice tone="err" size="micro" className="mb-1">{error}</InlineNotice>}
      {open.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-micro text-l4">{inlineDecisionLine(kind, "done")}</p>
          <button
            type="button"
            onClick={() => onAllDecided?.()}
            className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text"
          >
            让 Agent 按决定继续
          </button>
        </div>
      ) : (
        <>
          <p className="mb-1 text-micro leading-5 text-l4">{inlineDecisionLine(kind, "open")}</p>
          {/* 待核实的「接受」= 人对过原文、AI 去掉标记：一键全部接受等于没核就全转正（2026-10-24） */}
          {(kind !== "verify" || (onOpenFile && fileList.length > 0)) && (
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {kind !== "verify" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void acceptAll()}
                  className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
                >
                  {acceptingAll ? "接受中…" : "全部接受"}
                </button>
              )}
              {onOpenFile && fileList.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const primary = fileList[0]!;
                    onOpenFile({
                      path: primary.path,
                      root: primary.root ?? fileRoot,
                      name: primary.name,
                      rel: primary.rel ?? primary.name,
                      showList: true,
                      list: fileList,
                    });
                  }}
                  title="在右侧文件栏列出本批意见涉及的全部文件，边对照原稿边逐条决定"
                  className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
                >
                  {fileList.length > 1 ? `对照文件（${fileList.length}）` : "对照文件"}
                </button>
              )}
              {onOpenFileInWindow && fileList.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const primary = fileList[0]!;
                    onOpenFileInWindow({
                      path: primary.path,
                      root: primary.root ?? fileRoot,
                      name: primary.name,
                      rel: primary.rel ?? primary.name,
                      showList: true,
                      list: fileList,
                    });
                  }}
                  title="拆成独立新窗口打开对照文件：主窗口保留全宽看意见，点意见里的行号会在新窗口同步定位"
                  className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
                >
                  新窗口打开
                </button>
              )}
            </div>
          )}
        <ul className="max-h-72 space-y-2 overflow-auto">
          {open.map((item) => {
            const draft = drafts[item.id] ?? "";
            const tokens = tokenizeDecisionSummary(reviewItemSummary(item, kind));
            return (
              <li key={item.id} className="border-t border-hairline pt-2">
                <p className="text-xs leading-5 text-l1">
                  <span className="mr-1 text-l4">{item.id}</span>
                  {tokens.map((tok, tIdx) => {
                    if (tok.kind === "text") return <span key={tIdx}>{tok.text}</span>;
                    if (tok.kind === "code") {
                      return (
                        <code key={tIdx} className="rounded-sm bg-inset px-1 font-mono text-micro text-l2">
                          {tok.text}
                        </code>
                      );
                    }
                    const normRaw = tok.path.replace(/\\/g, "/").replace(/^\.\//, "");
                    const resolved = onOpenFile ? resolvedByRaw.get(normRaw) : undefined;
                    if (!onOpenFile || !resolved) {
                      return tok.code ? (
                        <code key={tIdx} className="rounded-sm bg-inset px-1 font-mono text-micro text-l2">
                          {tok.raw}
                        </code>
                      ) : (
                        <span key={tIdx}>{tok.raw}</span>
                      );
                    }
                    return (
                      <span key={tIdx}>
                        {tok.jumps.map((jump, jIdx) => (
                          <span key={`${tIdx}-${jIdx}`}>
                            {jump.sep}
                            <button
                              type="button"
                              onClick={() =>
                                onOpenFile({
                                  path: resolved.path,
                                  root: resolved.root,
                                  name: resolved.name,
                                  rel: resolved.rel,
                                  line: jump.line,
                                  list: fileList,
                                })
                              }
                              title={
                                jump.line
                                  ? `在右侧抽屉打开 ${resolved.rel}（第 ${jump.line} 行）`
                                  : `在右侧抽屉打开 ${resolved.rel}`
                              }
                              className="rounded-sm bg-inset px-1 font-mono text-micro text-cta underline decoration-dotted underline-offset-2 hover:opacity-80"
                            >
                              {jump.label}
                            </button>
                          </span>
                        ))}
                      </span>
                    );
                  })}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {VERDICTS.map((verdict) => (
                    <button
                      key={verdict}
                      type="button"
                      disabled={busy}
                      onClick={() => void choose(item, verdict)}
                      className={
                        verdict === "接受"
                          ? "rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
                          : "rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
                      }
                    >
                      {verdict}
                    </button>
                  ))}
                  {(() => {
                    const suggestion = itemSuggestion(item, kind);
                    // 灰字补全：框里是空的或者打的正是建议的开头，就把剩下的灰着接在后面，→ / Tab 收下
                    const rest =
                      suggestion && suggestion !== draft && suggestion.startsWith(draft)
                        ? suggestion.slice(draft.length)
                        : "";
                    return (
                      <div className="relative min-w-0 flex-1 rounded-sm bg-canvas" title={suggestion ? `建议改法：${suggestion}` : undefined}>
                        {rest && (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre rounded-sm border border-transparent px-1.5 py-0.5 text-micro"
                          >
                            <span className="invisible">{draft}</span>
                            <span className="text-l4">{rest}</span>
                          </div>
                        )}
                        <input
                          value={draft}
                          aria-label={`${item.id} 修改说明`}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [item.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            const el = event.currentTarget;
                            const atEnd = el.selectionStart === draft.length && el.selectionEnd === draft.length;
                            if (rest && atEnd && (event.key === "ArrowRight" || event.key === "Tab")) {
                              event.preventDefault();
                              setDrafts((prev) => ({ ...prev, [item.id]: suggestion }));
                            }
                          }}
                          placeholder={
                            suggestion
                              ? undefined
                              : kind === "verify"
                                ? "修改时写一句；核不了写「改成摘要级表述」或「保留待核实」"
                                : "修改时写一句"
                          }
                          className="relative w-full rounded-sm border border-field bg-transparent px-1.5 py-0.5 text-micro text-l2 outline-none placeholder:text-l4"
                        />
                      </div>
                    );
                  })()}
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}
