import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { readResearchFile } from "../research-report-load";
import { researchAbsolutePath } from "../research-report";
import {
  PERMISSION_STATUSES,
  parseDeclarations,
  parsePermissionRows,
  setPermissionStatus,
  writeDeclarations,
  type DeclarationSection,
  type PermissionRow,
} from "../handback-files";
import { InlineNotice } from "./PageFrame";

/** 读 + 带版本写回同一份文件（save_file_preview 的乐观锁：别处改过就报错，不覆盖） */
function useStepFile(root: string, rel: string) {
  const [text, setText] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let stale = false;
    setText(null);
    setError(null);
    readResearchFile(root, rel)
      .then((file) => {
        if (stale) return;
        setText(file.text);
        setRevision(file.revision);
      })
      .catch((reason) => !stale && setError(`读不到 ${rel}：${String(reason)}`));
    return () => {
      stale = true;
    };
  }, [root, rel]);
  async function save(next: string) {
    if (!revision) return false;
    setSaving(true);
    setError(null);
    try {
      const nextRevision = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(root, rel),
        root,
        text: next,
        expectedRevision: revision,
      });
      setText(next);
      setRevision(nextRevision);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setSaving(false);
    }
  }
  return { text, error, saving, save };
}

interface PaperGroup {
  key: string;
  paper: string;
  doiUrl: string | null;
  publisher: string;
  licence: string;
  need: string;
  rows: PermissionRow[];
}

function groupByPaper(rows: readonly PermissionRow[]): PaperGroup[] {
  const map = new Map<string, PaperGroup>();
  for (const row of rows) {
    const key = row.doiUrl ?? row.paper;
    const hit = map.get(key);
    if (hit) hit.rows.push(row);
    else
      map.set(key, {
        key,
        paper: row.paper,
        doiUrl: row.doiUrl,
        publisher: row.publisher,
        licence: row.licence,
        need: row.need,
        rows: [row],
      });
  }
  return [...map.values()];
}

/** 原文一栏「作者, 年份, *期刊* 卷, 页 — 题名」只取「作者, 年份, 期刊」那段 */
function shortCite(paper: string): string {
  return paper.split(" — ")[0].replace(/\*/g, "").trim();
}

/**
 * 换原图与转载许可：按论文一篇一行（同一篇的几块合在一次申请里），状态下拉一改就存；
 * 「文章页」直接打开 DOI，「原图文件夹」打开项目根 papers/figure-originals/（没有就建）。
 */
export function FigurePermissionsPanel({
  root,
  rel,
  projectRoot,
}: {
  root: string;
  rel: string;
  projectRoot: string;
}) {
  const file = useStepFile(root, rel);
  const groups = useMemo(() => groupByPaper(parsePermissionRows(file.text ?? "")), [file.text]);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  if (file.text == null) {
    return file.error ? <InlineNotice tone="err" size="micro">{file.error}</InlineNotice> : <p className="text-micro text-l4">读取清单…</p>;
  }
  if (groups.length === 0) return <p className="text-micro text-l4">清单里没有拼图块，不用申请。</p>;
  const count = (status: string) => groups.filter((g) => g.rows.every((r) => r.status === status)).length;
  const pending = count("待申请");

  async function setStatus(group: PaperGroup, status: string) {
    let next = file.text!;
    for (const row of group.rows) next = setPermissionStatus(next, row.line, status);
    await file.save(next);
  }

  async function openOriginals() {
    setFolderNote(null);
    const papers = `${projectRoot.replace(/[\\/]+$/, "")}/papers`;
    await invoke("fs_create_dir", { root: papers, name: "figure-originals" }).catch(() => {});
    await revealItemInDir(`${papers}/figure-originals`).catch((reason) =>
      setFolderNote(`打不开 ${papers}/figure-originals：${String(reason)}`),
    );
  }

  return (
    <div className="text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-micro text-l4">
        <span>
          {groups.length} 篇 · 待申请 {pending} 篇 · 已申请 {count("已申请")} · 已获许可 {count("已获许可")} · 无需申请 {count("无需申请")}
        </span>
        <button type="button" onClick={() => void openOriginals()} className="ml-auto rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1" title="期刊要出版社原图时，下载的高清原图放这里，文件名用「来源键-原图编号」">
          原图文件夹
        </button>
      </div>
      <ul className="max-h-80 space-y-1 overflow-auto">
        {groups.map((group) => {
          const mixed = new Set(group.rows.map((r) => r.status)).size > 1;
          const status = mixed ? "" : group.rows[0].status;
          return (
            <li key={group.key} className="flex items-start gap-2 border-t border-hairline pt-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-l1" title={group.paper}>{shortCite(group.paper)}</p>
                <p
                  className="truncate text-micro text-l4"
                  title={group.rows.map((r) => `图 ${r.figure} ← ${r.label}：${r.credit}`).join("\n")}
                >
                  图 {group.rows.map((r) => r.figure).join("、")} ← {group.rows.map((r) => r.label).join("、")} · {group.publisher} · {group.licence || "许可未查到"}
                </p>
              </div>
              {group.doiUrl && (
                <button
                  type="button"
                  onClick={() => void openUrl(group.doiUrl!).catch(() => {})}
                  title="打开文章页：找 Request permissions / Rights and permissions（多数走 RightsLink）申请；要原图也在这里下载"
                  className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-l3 hover:bg-hover hover:text-l1"
                >
                  文章页
                  <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
              <select
                value={status}
                disabled={file.saving}
                onChange={(event) => void setStatus(group, event.target.value)}
                aria-label={`${shortCite(group.paper)} 的状态`}
                className="shrink-0 rounded-sm border border-field bg-canvas px-1 py-0.5 text-xs text-l2"
              >
                {mixed && <option value="">各块不同</option>}
                {PERMISSION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
      {(file.error || folderNote) && (
        <InlineNotice tone="err" size="micro" className="mt-1">{file.error ?? folderNote}</InlineNotice>
      )}
    </div>
  );
}

/** 填作者、单位与投稿声明：一节一个框，离开框就存（不用找「保存」，也不会丢） */
export function DeclarationsForm({ root, rel }: { root: string; rel: string }) {
  const file = useStepFile(root, rel);
  const parsed = useMemo(() => parseDeclarations(file.text ?? ""), [file.text]);
  const [drafts, setDrafts] = useState<DeclarationSection[] | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => setDrafts(parsed), [parsed]);
  if (file.text == null || drafts == null) {
    return file.error ? <InlineNotice tone="err" size="micro">{file.error}</InlineNotice> : <p className="text-micro text-l4">读取声明…</p>;
  }
  if (drafts.length === 0) return <p className="text-micro text-l4">这份文件里没有「## 小标题」分节，回对话让 AI 按模板重写。</p>;

  async function saveIfChanged() {
    if (!drafts || drafts.every((s, i) => s.body === parsed[i]?.body)) return;
    if (await file.save(writeDeclarations(file.text!, drafts))) {
      setSavedAt(new Date().toLocaleTimeString());
    }
  }

  return (
    <div className="space-y-2 text-xs">
      {drafts.map((section, i) => (
        <label key={section.heading} className="block">
          <span className="mb-0.5 block text-micro text-l3">{section.label}</span>
          <textarea
            value={section.body}
            rows={Math.min(8, Math.max(2, section.body.split("\n").length + 1))}
            placeholder={section.hint || "待填"}
            onChange={(event) =>
              setDrafts((cur) =>
                cur ? cur.map((s, j) => (j === i ? { ...s, body: event.target.value } : s)) : cur,
              )
            }
            onBlur={() => void saveIfChanged()}
            className="w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
          />
        </label>
      ))}
      <p className="text-micro text-l4">
        {file.saving ? "保存中…" : savedAt ? `已保存 ${savedAt}` : "离开输入框就自动保存。空着的节会留成「待填」，不进稿件。"}
      </p>
      {file.error && <InlineNotice tone="err" size="micro">{file.error}</InlineNotice>}
    </div>
  );
}
