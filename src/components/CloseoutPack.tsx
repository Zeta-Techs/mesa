import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { readResearchFile } from "../research-report-load";
import { loadArtifactRows } from "./ArtifactChecklist";
import FileTypeMark from "./FileTypeMark";
import type { DirEntryDto } from "./FileTree";
import {
  closeoutFigureCards,
  closeoutNoteRows,
  groupCloseoutFiles,
  isCloseoutVisible,
  parseCloseoutIndex,
  type CloseoutFile,
  type CloseoutGroupId,
  type CloseoutNoteIndex,
  type CloseoutNoteSource,
} from "../closeout-pack";

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
}: {
  projectRoot: string;
  worktrees: readonly string[];
  entries: readonly string[];
}) {
  const setFilePreviewReq = useAppStore((s) => s.setFilePreviewReq);
  const setPage = useAppStore((s) => s.setPage);
  const [files, setFiles] = useState<CloseoutFile[] | null>(null);
  const [index, setIndex] = useState<CloseoutNoteIndex[]>([]);
  const [pdfs, setPdfs] = useState<CloseoutFile[]>([]);
  const [sources, setSources] = useState<CloseoutNoteSource[]>([]);
  const [open, setOpen] = useState<"figures" | "notes" | null>(null);
  const [packOpen, setPackOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const entryKey = entries.join("\n");
  const rootKey = [projectRoot, ...worktrees].join("\n");

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

  function openFile(file: CloseoutFile) {
    setFilePreviewReq({ projectRoot, path: file.abs, token: Date.now() });
    setPage("workspaces");
  }

  const finals = byId.get("final")?.files ?? [];
  const figures = closeoutFigureCards(byId.get("figures")?.files ?? []);
  const noteRows = closeoutNoteRows(byId.get("notes")?.files ?? [], index, pdfs, sources);
  const needle = query.trim().toLowerCase();
  const shownNotes = needle
    ? noteRows.filter((row) => `${row.title} ${row.note.name}`.toLowerCase().includes(needle))
    : noteRows;

  return (
    <div className="ccode-well mb-4 rounded-lg px-4 py-3.5">
      <button
        type="button"
        aria-expanded={packOpen}
        onClick={() => setPackOpen((cur) => !cur)}
        className="flex w-full items-center gap-2 text-left text-xs text-l2"
      >
        <span className="text-micro text-l4">{packOpen ? "▾" : "▸"}</span>
        完结文件
        <span className="text-micro text-l4">{finals.length > 0 ? `${finals.length} 份最终稿` : fileCount}</span>
      </button>
      {packOpen && (
    <div className="mt-2 space-y-2.5">
      {finals.length > 0 && (
        <FileSection label="最终稿" files={finals} onOpen={openFile} />
      )}
      {LINE_GROUPS.map(({ id, label }) => {
        const group = byId.get(id);
        if (!group) return null;
        const shown = openGroups.has(id);
        return (
          <Fold
            key={id}
            label={label}
            count={group.files.length}
            open={shown}
            onToggle={() => setOpenGroups((cur) => {
              const next = new Set(cur);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })}
          >
            <FileSection files={group.files} onOpen={openFile} />
          </Fold>
        );
      })}
      {figures.length > 0 && (
        <Fold
          label="附图"
          count={figures.filter((file) => file.label.startsWith("图 ")).length}
          open={open === "figures"}
          onToggle={() => setOpen((cur) => (cur === "figures" ? null : "figures"))}
        >
          <FileSection files={figures} onOpen={openFile} />
        </Fold>
      )}
      {noteRows.length > 0 && (
        <Fold
          label="笔记"
          count={noteRows.length}
          open={open === "notes"}
          onToggle={() => setOpen((cur) => (cur === "notes" ? null : "notes"))}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="题名、作者或年份"
            className="mb-1 w-full rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4"
          />
          <ul className="max-h-64 overflow-auto">
            {shownNotes.map((row) => (
              <li key={row.note.rel} className="flex items-center gap-2 rounded-md px-1 hover:bg-hover">
                <button
                  type="button"
                  title={row.note.rel}
                  onClick={() => openFile(row.note)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs text-l2"
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
          {shownNotes.length === 0 && <p className="mt-1 text-micro text-l4">没有这一篇。</p>}
        </Fold>
      )}
    </div>
      )}
    </div>
  );
}

function FileSection({
  label,
  files,
  onOpen,
}: {
  label?: string;
  files: readonly CloseoutFile[];
  onOpen: (file: CloseoutFile) => void;
}) {
  return (
    <section>
      {label && <h3 className="px-1 pt-1 text-micro text-l4">{label}</h3>}
      <div className="flex flex-wrap gap-1">
        {files.map((file) => (
          <button
            key={file.rel}
            type="button"
            title={file.rel}
            onClick={() => onOpen(file)}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-l2 hover:bg-hover hover:text-l1"
          >
            <FileTypeMark path={file.name} />
            <span className="truncate">{file.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Fold({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} className="text-xs text-l3 hover:text-l1">
        <span className="mr-1 inline-block w-3 text-micro text-l4">{open ? "▾" : "▸"}</span>
        {label}
        <span className="ml-1 text-micro text-l4">{count}</span>
      </button>
      {open && <div className="mt-1.5 pl-4">{children}</div>}
    </div>
  );
}
