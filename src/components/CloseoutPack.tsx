import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "../hotkeys";
import { pathWithin } from "../path-utils";
import { readResearchFile } from "../research-report-load";
import { DragOutHandle, loadArtifactRows } from "./ArtifactChecklist";
import FileTypeMark from "./FileTypeMark";
import { FoldMark } from "./PageFrame";
import type { DirEntryDto } from "./FileTree";
import {
  closeoutFigureCards,
  closeoutHint,
  closeoutNoteRows,
  groupCloseoutFiles,
  FIELD_DOC_HINT,
  isCloseoutFieldDoc,
  isCloseoutVisible,
  parseCloseoutIndex,
  type CloseoutFile,
  type CloseoutGroupId,
  type CloseoutNoteIndex,
  type CloseoutNoteSource,
} from "../closeout-pack";
import { showProjectFile } from "../project-file-open";

function relFromRoot(root: string, abs: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = abs.replace(/\\/g, "/");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

async function filesAt(root: string, entries: readonly string[]): Promise<CloseoutFile[]> {
  const rows = await loadArtifactRows([...entries], root);
  const found: CloseoutFile[] = [];
  for (const row of rows) {
    for (const file of row.files) {
      if (file.isDir) continue;
      const rel = relFromRoot(root, file.path);
      if (!isCloseoutVisible(rel)) continue;
      found.push({ rel, name: file.name, abs: file.path, label: "" });
    }
  }
  return found;
}

const LINE_GROUPS: { id: CloseoutGroupId; label: string }[] = [
  { id: "manuscript", label: "稿件" },
  { id: "library", label: "文献" },
  { id: "checks", label: "核对" },
];

/** 项目卡上的完结文件。最终稿四个入口常显；笔记和附图收成一行。 */
export default function CloseoutPack({
  projectRoot,
  worktrees,
  entries,
  defaultOpen = false,
  headerActions,
  workspaceId,
  flash = false,
}: {
  projectRoot: string;
  worktrees: readonly string[];
  entries: readonly string[];
  defaultOpen?: boolean;
  headerActions?: React.ReactNode;
  workspaceId?: string;
  flash?: boolean;
}) {
  const [files, setFiles] = useState<CloseoutFile[] | null>(null);
  const [index, setIndex] = useState<CloseoutNoteIndex[]>([]);
  const [pdfs, setPdfs] = useState<CloseoutFile[]>([]);
  const [sources, setSources] = useState<CloseoutNoteSource[]>([]);
  const [activeTab, setActiveTab] = useState<CloseoutGroupId | "figures" | "notes" | null>(null);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const packOpen = manualOpen ?? defaultOpen;
  const [query, setQuery] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const entryKey = entries.join("\n");
  const rootKey = [projectRoot, ...worktrees].join("\n");

  useEffect(() => {
    if (flash) setManualOpen(true);
  }, [flash]);

  useEffect(() => {
    let stale = false;
    setFiles(null);
    const wanted = entryKey ? entryKey.split("\n") : [];
    const roots = rootKey.split("\n").filter(Boolean);
    // 工作区在前：这一步刚写出的文件优先于项目里上一轮留下的同名文件。
    void (async () => {
      const merged = new Map<string, CloseoutFile>();
      for (const root of roots) {
        const found = await filesAt(root, wanted);
        if (stale) return;
        for (const file of found) {
          if (!merged.has(file.rel)) merged.set(file.rel, file);
        }
      }
      if (!stale) setFiles([...merged.values()]);
      for (const root of roots) {
        try {
          const file = await readResearchFile(root, "notes/index.json");
          if (stale) return;
          const parsed = parseCloseoutIndex(file.text);
          if (parsed.length) {
            setIndex(parsed);
            break;
          }
        } catch {
          /* 下一处 */
        }
      }
      const pdfsFound: CloseoutFile[] = [];
      const seenPdf = new Set<string>();
      for (const root of roots) {
        for (const dir of ["", "papers"]) {
          const path = dir ? `${root.replace(/[\\/]+$/, "")}/${dir}` : root;
          try {
            const rows = await invoke<DirEntryDto[]>("list_dir", { path, showHidden: false });
            for (const row of rows) {
              if (row.isDir || !row.name.toLowerCase().endsWith(".pdf") || seenPdf.has(row.path)) continue;
              seenPdf.add(row.path);
              pdfsFound.push({ rel: row.name, name: row.name, abs: row.path, label: "" });
            }
          } catch {
            /* 这一处没有 PDF */
          }
        }
      }
      if (!stale) setPdfs(pdfsFound);
      // 索引里没有的笔记（沉浸阅读建的）靠头部来源行配 PDF；读不到就按文件名显示
      try {
        const links = await invoke<CloseoutNoteSource[]>("list_paper_notes", { projectRoot });
        if (!stale) setSources(links);
      } catch {
        /* 来源行读不到不影响清单 */
      }
    })();
    return () => {
      stale = true;
    };
  }, [entryKey, rootKey]);

  const groups = useMemo(() => groupCloseoutFiles(files ?? []), [files]);
  const byId = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  if (files == null) return <p className="text-xs text-l4">完结文件 · 读取中…</p>;
  const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0);
  if (groups.length === 0) return <p className="text-xs text-l4">完结文件 · 定稿还没写出来</p>;

  function openExternal(file: CloseoutFile) {
    const roots = [projectRoot, ...worktrees];
    const root = roots.find((r) => pathWithin(file.abs, r, IS_WINDOWS)) ?? projectRoot;
    setOpenError(null);
    void invoke("open_in_system", { path: file.abs, root }).catch((reason) => setOpenError(String(reason)));
  }

  function openFile(file: CloseoutFile) {
    if (isCloseoutFieldDoc(file.rel)) {
      // 域稿交给系统里的 Word（Mesa 的预览跑不了 EndNote / Zotero 插件）
      openExternal(file);
      return;
    }
    const roots = [projectRoot, ...worktrees];
    const resolveRoot = (abs: string) => roots.find((r) => pathWithin(abs, r, IS_WINDOWS)) ?? projectRoot;
    const root = resolveRoot(file.abs);
    const list = groups
      .flatMap((group) => group.files)
      .filter((item) => !isCloseoutFieldDoc(item.rel))
      .map((item) => ({
        path: item.abs,
        name: item.name,
        root: resolveRoot(item.abs),
        rel: item.rel,
      }));
    void showProjectFile({
      projectRoot,
      root,
      path: file.abs,
      list: list.length > 1 ? list : undefined,
      from: "完结文件",
    });
  }

  const finals = byId.get("final")?.files ?? [];
  const figures = closeoutFigureCards(byId.get("figures")?.files ?? []);
  const noteRows = closeoutNoteRows(byId.get("notes")?.files ?? [], index, pdfs, sources);
  const needle = query.trim().toLowerCase();
  const shownNotes = needle
    ? noteRows.filter((row) => `${row.title} ${row.note.name}`.toLowerCase().includes(needle))
    : noteRows;

  const categoryTabs: { id: CloseoutGroupId | "figures" | "notes"; label: string; count: number }[] = [
    ...LINE_GROUPS.flatMap(({ id, label }) => {
      const group = byId.get(id);
      return group ? [{ id, label, count: group.files.length }] : [];
    }),
    ...(figures.length > 0
      ? [{ id: "figures" as const, label: "附图", count: figures.filter((file) => file.label.startsWith("图 ")).length }]
      : []),
    ...(noteRows.length > 0 ? [{ id: "notes" as const, label: "笔记", count: noteRows.length }] : []),
  ];

  return (
    <div
      data-ws-row={workspaceId}
      className={`ccode-well mt-3 rounded-lg px-4 py-3 ${flash ? "ring-2 ring-cta" : ""}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={packOpen}
          onClick={() => setManualOpen(!packOpen)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-l2 hover:text-l1"
        >
          <FoldMark open={packOpen} />
          <span className="font-medium text-l1">完结文件</span>
          <span className="text-micro tabular-nums text-l4">
            {finals.length > 0 ? `${finals.length} 份最终稿 · 共 ${fileCount} 份` : `${fileCount} 份`}
          </span>
        </button>
        {headerActions && (
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
          </div>
        )}
      </div>
      {packOpen && (
        <div className="mt-3 space-y-3 border-t border-hairline/60 pt-3">
          {finals.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-micro font-medium text-l4">最终稿</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {finals.map((file) => {
                  const fieldDoc = isCloseoutFieldDoc(file.rel);
                  return (
                    <div
                      key={file.rel}
                      className="group flex items-center rounded-md border border-hairline/75 bg-canvas/45 transition-colors hover:border-field hover:bg-hover"
                    >
                      <button
                        type="button"
                        onClick={() => openFile(file)}
                        title={fieldDoc ? FIELD_DOC_HINT : file.rel}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
                      >
                        <FileTypeMark path={file.name} />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-l1">{file.label}</span>
                          {closeoutHint(file.rel) && (
                            <span className="mt-0.5 block truncate text-micro text-l4">{closeoutHint(file.rel)}</span>
                          )}
                        </span>
                      </button>
                      <span className="mr-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {!fieldDoc && (
                          <button
                            type="button"
                            onClick={() => openExternal(file)}
                            title="用系统默认应用打开（PDF 阅读器、Word）"
                            aria-label={`用系统应用打开 ${file.label}`}
                            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-l4 hover:bg-hover hover:text-l2"
                          >
                            <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
                          </button>
                        )}
                        <DragOutHandle path={file.abs} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {openError && <p className="px-1 text-micro text-err-text">{openError}</p>}
          {categoryTabs.length > 0 && (
            <div className="border-t border-hairline/55 pt-2.5">
              <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="过程文件分类">
                {categoryTabs.map((tab) => {
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveTab((cur) => (cur === tab.id ? null : tab.id))}
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
                        selected
                          ? "border-field bg-seg-sel font-medium text-l1"
                          : "border-transparent bg-canvas/40 text-l3 hover:border-hairline hover:bg-hover hover:text-l1"
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span className="font-mono text-micro tabular-nums text-l4">{tab.count}</span>
                    </button>
                  );
                })}
              </div>
              {activeTab && activeTab !== "notes" && activeTab !== "figures" && byId.get(activeTab) && (
                <div className="mt-2.5 rounded-md border border-hairline/60 bg-canvas/35 p-2">
                  <FileSection files={byId.get(activeTab)!.files} onOpen={openFile} />
                </div>
              )}
              {activeTab === "figures" && figures.length > 0 && (
                <div className="mt-2.5 rounded-md border border-hairline/60 bg-canvas/35 p-2">
                  <FileSection files={figures} onOpen={openFile} />
                </div>
              )}
              {activeTab === "notes" && noteRows.length > 0 && (
                <div className="mt-2.5 rounded-md border border-hairline/60 bg-canvas/35 p-2">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="筛选题名、作者或年份"
                    className="mb-1.5 h-7 w-full rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                  <ul className="max-h-64 overflow-auto">
                    {shownNotes.map((row) => (
                      <li key={row.note.rel} className="flex items-center gap-2 rounded-md px-1.5 hover:bg-hover">
                        <button
                          type="button"
                          title={row.note.rel}
                          onClick={() => openFile(row.note)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs text-l2 hover:text-l1"
                        >
                          <FileTypeMark path={row.note.name} />
                          <span className="truncate">{row.title}</span>
                        </button>
                        {row.pdf ? (
                          <button
                            type="button"
                            title={row.pdf.name}
                            aria-label="打开全文"
                            onClick={() => openFile(row.pdf!)}
                            className="shrink-0 rounded-md p-1 hover:bg-hover"
                          >
                            <FileTypeMark path={row.pdf.name} />
                          </button>
                        ) : (
                          <span className="shrink-0 text-micro text-l4">无全文</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {shownNotes.length === 0 && <p className="mt-1 px-1 text-micro text-l4">没有这一篇。</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 过程文件：一行一份，名字后面跟一句用途，多列按格对齐（原先一排胶囊挤着换行，看不出哪份做什么） */
function FileSection({
  files,
  onOpen,
}: {
  files: readonly CloseoutFile[];
  onOpen: (file: CloseoutFile) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-x-3 gap-y-0.5">
      {files.map((file) => {
        const hint = closeoutHint(file.rel);
        return (
          <button
            key={file.rel}
            type="button"
            title={file.rel}
            onClick={() => onOpen(file)}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-hover"
          >
            <FileTypeMark path={file.name} />
            <span className="shrink-0 text-l2">{file.label}</span>
            {hint && <span className="min-w-0 truncate text-micro text-l4">{hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
