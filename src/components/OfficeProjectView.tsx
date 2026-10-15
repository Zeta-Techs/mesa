import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  File,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image,
  MessageSquare,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import OfficePreviewModal from "./OfficePreviewModal";
import {
  compactPrimaryActionClass,
  iconActionClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import FileKindFilters from "./FileKindFilters";
import { useAppStore } from "../store";
import { abbrevHome } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { absTime, relTime } from "../rel-time";
import { fileTypeIcon } from "../file-icons";
import {
  officeDocKind,
  officeFileInProgress,
  officeFileReuseKey,
  officeDocMatchesQuery,
  officePreviewMode,
  officeRecentKey,
  type OfficeDocKind,
} from "../work-mode";
import type { ProjectFileFilter } from "../project-files";
import { beginAskAi, beginProjectChat } from "./AskAiModal";
import { slotPrefs, CHAT_BINDING_SLOT, DISCUSS_BINDING_SLOT } from "../project-agents";
import {
  countTouchedSince,
  officeContinueItems,
  officeKindCounts,
  officePromptSuggestions,
  officeRecentPath,
  officeShowContinueCard,
  officeStatusLine,
  sessionMentionsFile,
  startOfYesterdayMs,
  type OfficePromptChip,
} from "../project-status";
import { buildFolderTree } from "../folder-groups";
import FolderGroupedList, { useFolderChrome } from "./FolderGroupedList";

import ProjectSessionsSection from "./ProjectSessionsSection";
import { useProjectSessionsOpen } from "../project-sessions-layout";

import type { OfficeDocDto, ProjectDto } from "../types";

const KIND_ICON: Record<OfficeDocKind, LucideIcon> = {
  sheet: FileSpreadsheet,
  doc: FileText,
  slide: Presentation,
  pdf: FileText,
  image: Image,
  other: File,
};

const KIND_COLOR: Record<OfficeDocKind, string> = {
  sheet: "#217346",
  doc: "#2b6cb0",
  slide: "#c43e1c",
  pdf: "#e5534b",
  image: "#a074c4",
  other: "#9c9c9c",
};

function OfficeFileMark({ path }: { path: string }) {
  const kind = officeDocKind(path);
  const Icon = KIND_ICON[kind];
  const color = fileTypeIcon(path)?.color ?? KIND_COLOR[kind];
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
      style={{ color, backgroundColor: `${color}26` }}
    >
      <Icon size={15} strokeWidth={1.8} />
    </span>
  );
}

function StatusPill({
  children,
  live = false,
}: {
  children: string;
  live?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-raised px-2 py-0.5 text-micro text-l2">
      {live && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-ok-text"
          style={{ boxShadow: "0 0 6px var(--color-ok-text)" }}
        />
      )}
      {children}
    </span>
  );
}

function loadRecent(projectPath: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(officeRecentKey(projectPath));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRecent(projectPath: string, map: Record<string, string>) {
  try {
    localStorage.setItem(officeRecentKey(projectPath), JSON.stringify(map));
  } catch {
    /* 隐私模式 */
  }
}

export default function OfficeProjectView({
  project,
  repoPath,
  homeDir,
  onError,
}: {
  project: ProjectDto | null;
  repoPath: string;
  homeDir: string;
  onError: (msg: string) => void;
}) {
  const sessions = useAppStore((s) => s.sessions);
  const profiles = useAppStore((s) => s.profiles);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const [docs, setDocs] = useState<OfficeDocDto[]>([]);
  const [filter, setFilter] = useState<ProjectFileFilter>("all");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<OfficeDocDto | null>(null);
  const [recentMap, setRecentMap] = useState<Record<string, string>>(() =>
    loadRecent(repoPath),
  );
  const [sessionsOpen, setSessionsOpen] = useProjectSessionsOpen();
  const folders = useFolderChrome(`office:${repoPath}`);

  function loadDocs() {
    invoke<OfficeDocDto[]>("list_office_docs", { root: repoPath })
      .then(setDocs)
      .catch((e) => onError(String(e)));
  }

  useEffect(() => {
    setRecentMap(loadRecent(repoPath));
    loadDocs();
    let watchId: string | null = null;
    let unlisten: (() => void) | undefined;
    invoke<string>("watch_dir", { path: repoPath })
      .then(async (id) => {
        watchId = id;
        unlisten = await listen(`fs-changed-${id}`, () => loadDocs());
      })
      .catch(() => {});
    return () => {
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, onError]);

  const liveReuseKeys = useMemo(
    () =>
      terminalRunInputs
        .filter((r) => r.running || r.attention === "confirm")
        .map((r) => r.reuseKey),
    [terminalRunInputs],
  );

  const rows = useMemo(() => {
    const withMeta = docs.map((d) => {
      const lastOpenedAt = recentMap[d.path] ?? null;
      const inProgress = officeFileInProgress(
        officeFileReuseKey(repoPath, d.rel),
        liveReuseKeys,
      );
      return { d, inProgress, lastOpenedAt };
    });
    const filtered = withMeta.filter((x) => {
      if (filter !== "all" && officeDocKind(x.d.path) !== filter) return false;
      return officeDocMatchesQuery(x.d.name, x.d.rel, query);
    });
    filtered.sort((a, b) => {
      const ta = Date.parse(a.lastOpenedAt || a.d.modified || "") || 0;
      const tb = Date.parse(b.lastOpenedAt || b.d.modified || "") || 0;
      return tb - ta;
    });
    return filtered;
  }, [docs, filter, query, recentMap, liveReuseKeys, repoPath]);

  const tree = useMemo(
    () => buildFolderTree(rows, (x) => x.d.rel),
    [rows],
  );

  function touchRecent(path: string) {
    const next = { ...recentMap, [path]: new Date().toISOString() };
    setRecentMap(next);
    saveRecent(repoPath, next);
  }

  function openPreview(d: OfficeDocDto) {
    touchRecent(d.path);
    if (officePreviewMode(d.path) === "external") {
      void invoke("open_in_system", { path: d.path, root: repoPath }).catch(
        (e) => onError(String(e)),
      );
      return;
    }
    setPreview(d);
  }

  function movePreview(offset: number) {
    if (!preview) return;
    const index = rows.findIndex((row) => row.d.path === preview.path);
    const next = rows[index + offset]?.d;
    if (next) setPreview(next);
  }

  function askAi(
    d: OfficeDocDto,
    e?: { metaKey: boolean; ctrlKey: boolean },
    prompt?: string,
  ) {
    touchRecent(d.path);
    beginAskAi(
      {
        path: d.path,
        name: d.name,
        cwd: repoPath,
        root: repoPath,
        reuseKey: officeFileReuseKey(repoPath, d.rel),
        prompt,
        ...slotPrefs(profiles, project, DISCUSS_BINDING_SLOT),
      },
      { forcePick: !!(e?.metaKey || e?.ctrlKey) },
    );
    setPreview(null);
  }

  const name = project?.name ?? repoPath.split(/[\\/]/).pop() ?? repoPath;
  const continueDocs = useMemo(
    () => officeContinueItems(docs, recentMap, 3),
    [docs, recentMap],
  );
  const showContinue = officeShowContinueCard(docs.length, continueDocs.length);
  const recentPath = officeRecentPath(docs, recentMap);
  const promptChips = useMemo(
    () => officePromptSuggestions(docs, recentMap, 2),
    [docs, recentMap],
  );
  const kindCounts = useMemo(
    () => officeKindCounts(docs.map((d) => d.path)),
    [docs],
  );
  const statusLine = officeStatusLine({
    total: docs.length,
    touchedYesterday: countTouchedSince(
      docs.map((d) => ({
        modified: d.modified,
        lastOpenedAt: recentMap[d.path] ?? null,
      })),
      startOfYesterdayMs(Date.now()),
    ),
  });

  function startProjectChat(e?: { metaKey: boolean; ctrlKey: boolean }) {
    beginProjectChat(
      {
        cwd: repoPath,
        name,
        kind: "office",
        ...slotPrefs(profiles, project, CHAT_BINDING_SLOT),
      },
      { forcePick: !!(e?.metaKey || e?.ctrlKey) },
    );
  }

  function askChip(chip: OfficePromptChip, e?: { metaKey: boolean; ctrlKey: boolean }) {
    const d = docs.find((x) => x.path === chip.filePath);
    if (!d) return;
    askAi(d, e, chip.prompt);
  }

  return (
    <div
      className={`flex flex-row items-start ccode-project-work-well${
        sessionsOpen ? " ccode-project-sessions-open" : ""
      }`}
    >
      <div className="ccode-project-work-main min-w-0 flex-1 space-y-5">
      <section>
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold tracking-tight text-l1">{name}</p>
            <p className="mt-1 font-mono text-micro text-l4" title={repoPath}>
              {homeDir ? abbrevHome(repoPath, homeDir, IS_WINDOWS) : repoPath}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-l3">
              <span className="rounded-full bg-strip px-2 py-0.5 text-micro text-l2">
                工作
              </span>
              <span className="text-micro text-l4">{statusLine}</span>
            </p>
          </div>
          {!sessionsOpen && (
            <ProjectSessionsSection
              projectPath={repoPath}
              variant="sidebar"
              collapsed
              onToggle={() => setSessionsOpen(true)}
              title="这个项目的对话"
              defaultProfiles={project?.defaultProfiles}
            />
          )}
        </div>
      </section>

        <section className="min-w-0">
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <FileText size={14} strokeWidth={1.8} className="text-l4" />
            <h2 className="text-xs font-medium text-l2">文档</h2>
            {docs.length > 0 && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索"
                className={`${searchFieldClass} ml-auto w-44`}
                aria-label="搜索文档"
              />
            )}
            <FileKindFilters
              filter={filter}
              counts={kindCounts}
              onChange={setFilter}
            />
          </div>

          {showContinue && (
            <div className="mb-3">
              <h3 className="mb-0.5 px-1.5 text-micro text-l3">继续上次</h3>
              <ul className="space-y-0.5">
                {continueDocs.map((d) => (
                  <li key={d.path}>
                    <button
                      type="button"
                      className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-hover"
                      onClick={() => openPreview(d)}
                    >
                      <OfficeFileMark path={d.path} />
                      <span className="min-w-0 flex-1 truncate text-sm text-l1">
                        {d.name}
                      </span>
                      <span
                        className="shrink-0 text-micro text-l4"
                        title={absTime(recentMap[d.path] ?? d.modified)}
                      >
                        {relTime(recentMap[d.path] ?? d.modified)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {docs.length === 0 ? (
            <p className="px-1 py-2 text-xs text-l4">文档 · 还没有</p>
          ) : rows.length === 0 ? (
            <p className="px-1 py-2 text-xs text-l4">没有匹配</p>
          ) : (
            <FolderGroupedList
              tree={tree}
              searching={!!query.trim() || filter !== "all"}
              expanded={folders.expanded}
              onToggle={folders.toggle}
              cap={0}
              revealed={folders.revealed}
              onReveal={folders.reveal}
              rowKey={(x) => x.d.path}
              renderRow={({ d, inProgress }) => {
                const showRecent =
                  !showContinue && recentPath === d.path && !inProgress;
                const hasTalk = sessions.some((s) =>
                  sessionMentionsFile(s, d.name),
                );
                return (
                  <li className="group relative flex min-h-10 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-hover">
                    <OfficeFileMark path={d.path} />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm text-l1"
                      onClick={() => openPreview(d)}
                      title={d.rel}
                    >
                      {d.name}
                    </button>
                    {inProgress && <StatusPill live>进行中</StatusPill>}
                    {showRecent && <StatusPill>最近编辑</StatusPill>}
                    {hasTalk && <StatusPill>对话</StatusPill>}
                    <span
                      className="shrink-0 text-micro text-l4 group-hover:hidden group-focus-within:hidden"
                      title={absTime(d.modified)}
                    >
                      {relTime(d.modified)}
                    </span>
                    <span className="absolute inset-y-0 right-1 hidden items-center bg-hover pl-1 group-hover:flex group-focus-within:flex">
                      <button
                        type="button"
                        className={iconActionClass}
                        title="问 AI · ⌘ / Ctrl + 点可重选"
                        aria-label="问 AI"
                        onClick={(e) => askAi(d, e)}
                      >
                        <MessageSquare size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={iconActionClass}
                        title="系统打开"
                        aria-label="系统打开"
                        onClick={() => {
                          touchRecent(d.path);
                          void invoke("open_in_system", {
                            path: d.path,
                            root: repoPath,
                          }).catch((e) => onError(String(e)));
                        }}
                      >
                        <AppWindow size={13} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className={iconActionClass}
                        title="显示"
                        aria-label="显示"
                        onClick={() => {
                          touchRecent(d.path);
                          void revealItemInDir(d.path).catch((e) =>
                            onError(String(e)),
                          );
                        }}
                      >
                        <FolderOpen size={13} strokeWidth={1.8} />
                      </button>
                    </span>
                  </li>
                );
              }}
            />
          )}
        </section>
      </div>

        {sessionsOpen && (
        <aside
          className={`ccode-project-sessions-rail ${
            sessionsOpen ? "ccode-project-sessions-rail-open" : ""
          }`}
        >
          <div className="flex min-w-0 flex-col gap-4">
            <ProjectSessionsSection
              projectPath={repoPath}
              variant="sidebar"
              collapsed={false}
              onToggle={() => setSessionsOpen(false)}
              title="这个项目的对话"
              defaultProfiles={project?.defaultProfiles}
              onNewChat={startProjectChat}
              empty={
                <div className="flex flex-col gap-2">
                  {promptChips.map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      className={`${rowActionClass} h-auto min-h-7 w-full justify-start py-1.5 text-left`}
                      title="⌘ / Ctrl + 点可重选 Agent 和配置"
                      onClick={(e) => askChip(chip, e)}
                    >
                      {chip.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`${compactPrimaryActionClass} w-full`}
                    title="⌘ / Ctrl + 点可重选 Agent 和配置"
                    onClick={(e) => startProjectChat(e)}
                  >
                    ＋ 发起新对话
                  </button>
                </div>
              }
            />
          </div>
        </aside>
        )}

      {preview && (
        <OfficePreviewModal
          path={preview.path}
          root={repoPath}
          onClose={() => setPreview(null)}
          onAskAi={() => askAi(preview)}
          onPrevious={() => movePreview(-1)}
          onNext={() => movePreview(1)}
          hasPrevious={rows.findIndex((row) => row.d.path === preview.path) > 0}
          hasNext={
            rows.findIndex((row) => row.d.path === preview.path) >= 0 &&
            rows.findIndex((row) => row.d.path === preview.path) < rows.length - 1
          }
        />
      )}
    </div>
  );
}
