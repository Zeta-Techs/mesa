import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Briefcase,
  ChevronDown,
  Code,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  GitBranch,
  House,
  MessageCircle,
  Search,
} from "lucide-react";
import type { ProjectDto } from "../types";
import { AGENTS } from "../types";
import { useMenuKeyNav } from "../menu-key-nav";
import { clipBounds, pickPopoverSide, popoverRoom } from "../popover-side";
import { pickerRows, type PickerFixedRow } from "../chat-project-picker";
import { WORK_MODE_LABEL, type WorkMode } from "../work-mode";

export type DirPick = { kind: "scratch" | "home" | "project" | "folder"; path: string };

const MENU_CAP = 460;

const MODE_ICON: Record<WorkMode, typeof Code> = {
  research: FlaskConical,
  coding: Code,
  office: Briefcase,
};

/**
 * 聊天输入框左下的项目芯片与选择弹层（docs/design-chat-composer-mockup.html ①，2026-10-22）。
 * 原先点开的是通用右键菜单（只列 6 个、不能搜、看不出类型）；现在和权限、模型两个弹层同一族：
 * 顶上搜索，列表按最近活动、每行带项目类型（编程项目写当前分支）与项目默认的 Agent，随手聊 / 主目录固定在下，
 * 末尾「选择文件夹…」「新建项目…」。选了项目带上它的默认 Agent 由标签那边做（TerminalPage pickDir），
 * 只在开聊前出现（开聊后目录不能再换）。
 */
export default function ChatProjectPicker({
  cwd,
  homeDir,
  label,
  projects,
  recentRepos,
  isWindows,
  onPick,
  onChooseFolder,
  onNewProject,
}: {
  cwd: string;
  homeDir: string;
  /** 芯片上的字（cwdChipLabel） */
  label: string;
  projects: ProjectDto[];
  recentRepos: readonly { path: string; name?: string; lastActive?: string | null }[];
  isWindows: boolean;
  onPick: (pick: DirPick) => void;
  onChooseFolder: () => void;
  onNewProject?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useMenuKeyNav(menuRef, open);
  // 打开先落到搜索框（useMenuKeyNav 会先把焦点给当前项，这里在它之后接过来）
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);
  const [side, setSide] = useState<"above" | "below">("above");
  const [room, setRoom] = useState(MENU_CAP);
  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return;
    const anchor = rootRef.current.getBoundingClientRect();
    const bounds = clipBounds(rootRef.current);
    const s = pickPopoverSide(anchor, bounds, Math.min(menuRef.current.scrollHeight, MENU_CAP));
    setSide(s);
    setRoom(popoverRoom(anchor, bounds, s, MENU_CAP));
  }, [open, query]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const { rows, fixed } = pickerRows({ projects, recentRepos, cwd, home: homeDir, query, isWindows });

  // 编程项目写当前分支：打开时对列出来的编程项目各查一次（最多十来个）
  const [branches, setBranches] = useState<Record<string, string>>({});
  const codingKey = open ? rows.filter((r) => r.workMode === "coding").map((r) => r.path).join("\n") : "";
  useEffect(() => {
    if (!codingKey) return;
    let stale = false;
    for (const path of codingKey.split("\n")) {
      if (branches[path] !== undefined) continue;
      void invoke<{ isRepo: boolean; branch: string }>("git_status", { cwd: path })
        .then((st) => {
          if (!stale && st.isRepo && st.branch) setBranches((cur) => ({ ...cur, [path]: st.branch }));
        })
        .catch(() => {});
    }
    return () => {
      stale = true;
    };
    // branches 只做「查过没有」的缓存，不该触发重查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codingKey]);

  const current = rows.find((r) => r.current);
  const fixedCurrent = fixed.find((f) => f.current);
  const ChipIcon = current
    ? MODE_ICON[current.workMode]
    : fixedCurrent?.kind === "scratch"
      ? MessageCircle
      : fixedCurrent?.kind === "home"
        ? House
        : FolderOpen;

  function pick(p: DirPick) {
    setOpen(false);
    onPick(p);
  }
  const row = (selected: boolean) =>
    `flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left outline-none ${
      selected ? "bg-seg-sel text-l1" : "text-l2 hover:bg-hover hover:text-l1 focus-visible:bg-hover"
    }`;
  const fixedIcon = (f: PickerFixedRow) => (f.kind === "scratch" ? MessageCircle : House);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${cwd === "~" && homeDir ? homeDir : cwd}\n点击换项目或文件夹`}
        className={`ml-1 flex h-6 min-w-0 max-w-[14rem] items-center gap-1 rounded-md px-1.5 text-micro hover:bg-hover hover:text-l1 ${
          open ? "bg-hover text-l1" : "text-l3"
        }`}
      >
        <ChipIcon size={12} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{label}</span>
        {/* 只有项目芯片带小箭头：它换掉的是整个起点 */}
        <ChevronDown size={11} strokeWidth={1.8} aria-hidden="true" className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="dialog"
          aria-label="在哪个项目里聊"
          // 字号挂在容器上：全站 button / input { font: inherit } 会吞掉控件自己的 text-*
          className={`absolute left-0 z-30 flex w-[20rem] flex-col rounded-xl border border-field ccode-float-surface p-1 text-sm shadow-lg ${
            side === "below" ? "top-full mt-2" : "bottom-full mb-2"
          }`}
          style={{ maxHeight: room }}
        >
          <label className="mx-0.5 mb-1 mt-0.5 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-inset px-2 text-xs text-l3">
            <Search size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const first = rows[0];
                  if (first) pick({ kind: "project", path: first.path });
                  else if (fixed[0]) pick({ kind: fixed[0].kind, path: fixed[0].path });
                }
              }}
              placeholder="找项目或文件夹"
              aria-label="找项目或文件夹"
              className="ccode-picker-search min-w-0 flex-1 bg-transparent text-l1 outline-none placeholder:text-l4"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {rows.length > 0 && (
              <div className="px-2 pb-1 pt-0.5 text-xs text-l4">{query.trim() ? "项目" : "最近"}</div>
            )}
            {rows.map((r) => {
              const Icon = MODE_ICON[r.workMode];
              const agent = r.defaultAgent ? (AGENTS.find((a) => a.id === r.defaultAgent)?.label ?? r.defaultAgent) : null;
              const branch = branches[r.path];
              return (
                <button
                  key={r.path}
                  type="button"
                  data-selected={r.current}
                  className={row(r.current)}
                  title={r.path}
                  onClick={() => pick({ kind: "project", path: r.path })}
                >
                  <Icon size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                  <span className="min-w-0 truncate">{r.label}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-l4">
                    {branch ? (
                      <>
                        <GitBranch size={11} strokeWidth={1.8} aria-hidden="true" />
                        <span className="max-w-[6rem] truncate">{branch}</span>
                      </>
                    ) : (
                      WORK_MODE_LABEL[r.workMode]
                    )}
                    {agent && <span>· 默认 {agent}</span>}
                  </span>
                </button>
              );
            })}
            {rows.length === 0 && query.trim() && fixed.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-l4">没找到「{query.trim()}」的项目，可以用下面的「选择文件夹…」</p>
            )}
            {fixed.length > 0 && rows.length > 0 && <div className="mx-1 my-1 h-px bg-hairline" />}
            {fixed.map((f) => {
              const Icon = fixedIcon(f);
              return (
                <button
                  key={f.kind}
                  type="button"
                  data-selected={f.current}
                  className={row(f.current)}
                  title={f.path}
                  onClick={() => pick({ kind: f.kind, path: f.path })}
                >
                  <Icon size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
                  <span className="min-w-0 truncate">{f.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-l4">{f.kind === "scratch" ? "不挂在项目下" : "~"}</span>
                </button>
              );
            })}
          </div>
          <div className="mx-1 my-1 h-px shrink-0 bg-hairline" />
          <button
            type="button"
            className={`${row(false)} shrink-0`}
            onClick={() => {
              setOpen(false);
              onChooseFolder();
            }}
          >
            <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
            选择文件夹…
            <span className="ml-auto shrink-0 text-xs text-l4">也可以把文件夹拖进来</span>
          </button>
          {onNewProject && (
            <button
              type="button"
              className={`${row(false)} shrink-0`}
              title="起个名字建一个新文件夹，定好工作方式后登记为项目（在项目页完成）"
              onClick={() => {
                setOpen(false);
                onNewProject();
              }}
            >
              <FolderPlus size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
              新建项目…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
