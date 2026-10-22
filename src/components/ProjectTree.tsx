import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eraser,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  groupByWorkMode,
  normalizeWorkMode,
  RAIL_WORK_MODE_LABEL,
} from "../work-mode";
import { useAnimatedDismiss } from "../exit-animation";
import { revealFolderLabel, samePath } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { projectRailStatus } from "../run-overview";
import {
  applyOrder,
  isPinned,
  parsePins,
  PROJECT_ORDER_KEY,
  PROJECT_PINS_KEY,
  reorderGroup,
  splitPinned,
  togglePin,
} from "../project-tree";
import { clampTabDragDx, rubberbandTabDx, tabDragTarget } from "../tab-drag";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import RenameProjectModal from "./RenameProjectModal";
import { toast } from "../toast";
import type { ProjectDto, WorkspaceDto } from "../types";

const GROUPS_KEY = "ccode.projectTreeGroups";
/** 课题数超过它才在标签行出放大镜（点开才有搜索框） */
const SEARCH_MIN = 5;

/** 树行：注册项目（project 非空）与未添加仓库（沉底「未添加」段）统一形状 */
type TreeRow = {
  key: string;
  repoPath: string;
  name: string;
  project: ProjectDto | null;
};

/** 项目树（侧栏展开态）：「项目」标签行 + 搜索 + 按工作方式分组的课题列表。
 *  行点击 = onSelect(repoPath)（App 侧 setSelectProjectReq + setPage("workspaces")，
 *  与收件箱/对话页卡片同一跳转链）；行右键 = 重命名 / 复制路径 / 从 Mesa 移除 /
 *  清除痕迹 / 删除目录，动作自持，完成后 bump projectsVersion 通知本树与项目页重拉。
 *  选中高亮吃 contextLabel.projectPath（项目页唯一写入方的「当前项目」镜像）。
 *  行首状态点只认「此刻有 Agent 在跑」（绿点）；待处理黄点归顶栏收件箱与工作台，不在此重复计算。 */
export default function ProjectTree({
  selectedRoot,
  active,
  onSelect,
}: {
  selectedRoot: string | null;
  /** 主区此刻就在项目页：当前课题铺选中底；在别的页时只留「当前课题」弱提示（加粗、不铺底），
   *  不和系统段的选中项抢成两处选中 */
  active: boolean;
  onSelect: (repoPath: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [repos, setRepos] = useState<
    Pick<WorkspaceDto, "repoPath" | "repoName" | "worktreePath">[]
  >([]);
  // 分组折叠态跨重启记忆；缺省三种方式展开、「未添加」收着
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* 读不出就用缺省 */
    }
    return new Set(["research", "coding", "office"]);
  });
  const [searchQuery, setSearchQuery] = useState("");
  // 搜索框平时收成标签行的放大镜，点开才占一行；清空并失焦 / Esc 收回
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    row: TreeRow;
    /** ⋯ 按钮打开时菜单右缘对齐按钮；右键打开时贴光标 */
    alignRight?: boolean;
  } | null>(null);
  // 置顶：界面偏好记本机（同分组折叠态），置顶课题单列最上「置顶」段
  const [pins, setPins] = useState<string[]>(() => {
    try {
      return parsePins(localStorage.getItem(PROJECT_PINS_KEY));
    } catch {
      return [];
    }
  });
  function togglePinFor(row: TreeRow) {
    setPins((prev) => {
      const next = togglePin(prev, row.repoPath, IS_WINDOWS);
      try {
        localStorage.setItem(PROJECT_PINS_KEY, JSON.stringify(next));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
  }
  // 组内顺序（拖动排序）：同置顶，界面偏好记本机；置顶段的顺序就是 pins 表本身
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return parsePins(localStorage.getItem(PROJECT_ORDER_KEY));
    } catch {
      return [];
    }
  });
  function saveList(key: string, next: string[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* 存不下只影响下次启动 */
    }
  }
  // 组内拖动排序（同运行页标签拖动：pointer 事件自实现，不用 HTML5 拖放——Tauri 原生文件拖放会拦掉
  // WKWebView 的拖拽手势）：竖向位移超 6px 进拖拽，源行跟手、其余行滑动让位，松手先吸附再落定。
  // 只在同一段（置顶 / 某个工作方式组）里拖，不能跨组：分组由工作方式决定。搜索时不拖。
  const [drag, setDrag] = useState<{
    section: string;
    key: string;
    from: number;
    target: number;
    dy: number;
    /** 拖拽开始时本段各行的测量值（复用标签条的一维槽位：left=top、width=height） */
    slots: { left: number; width: number }[];
    settling: boolean;
  } | null>(null);
  // 拖完松手的那次 click 吞掉（拖排序不该顺手打开课题）
  const suppressClickRef = useRef(false);
  function onRowPointerDown(
    e: React.PointerEvent,
    section: string,
    paths: string[],
    key: string,
  ) {
    if (e.button !== 0 || searchQuery || paths.length < 2) return;
    const rowEl = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    let active = false;
    let slots: { left: number; width: number }[] = [];
    let from = 0;
    let lastTarget = 0;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    const finish = () => {
      cleanup();
      if (!active) return;
      suppressClickRef.current = true;
      // 吞 click 只管紧随的这一次；松手落在行外就没有 click，别让它留到下次真点击
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const target = lastTarget;
      if (target === from) {
        setDrag(null);
        return;
      }
      setDrag((cur) =>
        cur
          ? { ...cur, dy: cur.slots[target].left - cur.slots[from].left, settling: true }
          : null,
      );
      window.setTimeout(() => {
        if (section === "pinned") {
          setPins((prev) => {
            const next = reorderGroup(prev, paths, from, target, IS_WINDOWS);
            saveList(PROJECT_PINS_KEY, next);
            return next;
          });
        } else {
          setOrder((prev) => {
            const next = reorderGroup(prev, paths, from, target, IS_WINDOWS);
            saveList(PROJECT_ORDER_KEY, next);
            return next;
          });
        }
        setDrag(null);
      }, 170);
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) <= 6) return;
        active = true;
        // 进入拖拽态才测量（此刻布局未变）；querySelectorAll 顺序 = 本段显示顺序
        const els = Array.from(
          (rowEl.parentElement ?? rowEl).querySelectorAll<HTMLElement>("[data-tree-row]"),
        );
        slots = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.top, width: r.height };
        });
        from = Math.max(0, els.findIndex((el) => el.getAttribute("data-tree-row") === key));
        lastTarget = from;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        setMenu(null);
      }
      const raw = ev.clientY - startY;
      const target = tabDragTarget(slots, from, clampTabDragDx(slots, from, raw));
      lastTarget = target;
      setDrag({
        section,
        key,
        from,
        target,
        dy: rubberbandTabDx(slots, from, raw),
        slots,
        settling: false,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const projectsVersion = useAppStore((s) => s.projectsVersion);
  const pathsSig = useAppStore((s) => s.projectPaths.join("\n"));
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);

  // 列表数据：注册表 + 工作区清单（后者推「未添加」段与工作区计数）。重拉触发：
  // 管理动作后的 projectsVersion、跨实例/终端侧注册落盘后的 projectPaths 签名变化
  useEffect(() => {
    let cancelled = false;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        /* 下一次版本变化重试 */
      });
    invoke<Pick<WorkspaceDto, "repoPath" | "repoName" | "worktreePath">[]>(
      "list_workspaces",
    )
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch(() => {
        /* 未添加段缺席不阻塞注册项目 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectsVersion, pathsSig]);

  const rows = useMemo<TreeRow[]>(() => {
    const unregistered: TreeRow[] = [];
    const seen: string[] = [];
    for (const w of repos) {
      if (projects.some((p) => samePath(p.path, w.repoPath, IS_WINDOWS)))
        continue;
      if (seen.some((s) => samePath(s, w.repoPath, IS_WINDOWS))) continue;
      seen.push(w.repoPath);
      unregistered.push({
        key: `r:${w.repoPath}`,
        repoPath: w.repoPath,
        name: w.repoName,
        project: null,
      });
    }
    return [
      ...projects.map((p) => ({
        key: `p:${p.path}`,
        repoPath: p.path,
        name: p.name,
        project: p,
      })),
      ...unregistered,
    ];
  }, [projects, repos]);

  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.repoPath.toLowerCase().includes(q),
        )
      : rows;
    const { pinned, rest } = splitPinned(filtered, pins, IS_WINDOWS);
    return {
      pinned,
      groups: groupByWorkMode(
        applyOrder(rest, order, (r) => r.repoPath, IS_WINDOWS),
        (r) => (r.project ? r.project.workMode : "unregistered"),
      ),
    };
  }, [rows, searchQuery, pins, order]);

  const toggleGroup = (mode: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) next.delete(mode);
      else next.add(mode);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        /* 存不下只影响下次启动 */
      }
      return next;
    });
  };

  /** 管理动作收尾：拉平 store 镜像 + 自增代数（本树与项目页都据此重拉） */
  function reload() {
    const s = useAppStore.getState();
    s.loadProjects().catch(() => {});
    s.bumpProjectsVersion();
  }

  function menuItems(row: TreeRow): ContextMenuItem[] {
    const wsCount = repos.filter((w) =>
      samePath(w.repoPath, row.repoPath, IS_WINDOWS),
    ).length;
    const pinned = isPinned(pins, row.repoPath, IS_WINDOWS);
    return [
      {
        label: pinned ? "取消置顶" : "置顶",
        icon: pinned ? PinOff : Pin,
        onSelect: () => togglePinFor(row),
      },
      {
        label: "在终端打开",
        icon: SquareTerminal,
        title: "在运行页开一个终端标签，目录就是这个课题",
        onSelect: () => {
          const st = useAppStore.getState();
          st.setEnterCwdReq(row.repoPath);
          st.setPage("terminal");
        },
      },
      {
        label: "重命名项目",
        icon: Pencil,
        disabled: !row.project,
        title: row.project ? undefined : "这个文件夹还没添加到 Mesa",
        onSelect: () =>
          row.project &&
          setRenameTarget({ path: row.repoPath, name: row.project!.name }),
      },
      {
        label: revealFolderLabel(IS_MAC, IS_WINDOWS),
        icon: FolderOpen,
        onSelect: () => {
          void revealItemInDir(row.repoPath).catch((e) =>
            toast(`打不开文件夹：${String(e)}`, "error"),
          );
        },
      },
      {
        label: "复制项目路径",
        icon: Copy,
        onSelect: () => {
          void navigator.clipboard
            .writeText(row.repoPath)
            .then(() => toast("已复制项目路径"))
            .catch(() => toast("复制项目路径失败", "error"));
        },
      },
      { separator: true },
      {
        label: "从 Mesa 移除",
        icon: FolderMinus,
        disabled: !row.project,
        title: row.project
          ? "只移除注册记录，文件夹与工作区都保留"
          : "这个文件夹还没添加到 Mesa",
        onSelect: () => row.project && void removeRegistration(row),
      },
      {
        label: "清除 Mesa 痕迹…",
        icon: Eraser,
        danger: true,
        title: "保留文件夹与你的全部文件；清掉工作区、.ccode 与注册记录",
        onSelect: () => void purgeTraces(row),
      },
      {
        label: "删除项目目录…",
        icon: Trash2,
        danger: true,
        title: "目录移入回收站（可找回）；工作区与分支彻底删除",
        onSelect: () => void deleteProjectDir(row, wsCount),
      },
    ];
  }

  /** 移除项目注册（只删注册记录，不动磁盘目录与工作区） */
  async function removeRegistration(row: TreeRow) {
    if (
      !(await confirmDialog(
        `只移除「${row.name}」的项目注册，不删除磁盘目录；项目内工作区保留。继续？`,
      ))
    )
      return;
    try {
      await invoke("remove_project", { path: row.repoPath });
      reload();
    } catch (reason) {
      toast(`移除失败：${String(reason)}`, "error");
    }
  }

  /** 清除 Mesa 痕迹（中间档）：文件夹与用户文件保留；工作区/分支彻底删，.ccode 入回收站，注册摘除 */
  async function purgeTraces(row: TreeRow) {
    if (
      !(await confirmDialog(
        `清除「${row.name}」的 Mesa 痕迹？\n\n` +
          `文件夹与你的文件：保留\n` +
          `.ccode/（档案卡、任务卡、各步骤 TASK.md 内容）：移入回收站（可找回）\n` +
          `工作区 worktree 与分支、注册记录：彻底删除\n\n` +
          `注意：如果 .ccode 曾被 git 跟踪，改动面板会显示对应删除，需要你自行提交。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      const msg = await invoke<string>("purge_project_traces", {
        path: row.repoPath,
      });
      toast(msg);
      reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  /** 删除项目：工作区（彻底删）+ 主目录（移入回收站）+ 注册记录（未添加仓库同样可用） */
  async function deleteProjectDir(row: TreeRow, wsCount: number) {
    if (
      !(await confirmDialog(
        `删除项目「${row.name}」？\n\n目录：${row.repoPath}\n工作区：${wsCount} 个\n\n目录将移入系统回收站（可找回）；工作区的 worktree 与分支将彻底删除、不可恢复。请先关闭该项目内正在运行的终端标签。`,
        { danger: true },
      ))
    )
      return;
    try {
      await invoke<string>("delete_project_dir", { path: row.repoPath });
      reload();
    } catch (reason) {
      toast(String(reason), "error");
    }
  }

  /** 一行课题：整行是主按钮（点进项目页、右键出菜单），右侧 ⋯ 悬停 / 键盘聚焦 / 菜单开着时出现。
   *  按钮不能嵌套，所以外层是 div 承载底色，主按钮与 ⋯ 并排。 */
  function renderRow(row: TreeRow, index: number, section: string, paths: string[]) {
    const selected =
      selectedRoot != null && samePath(selectedRoot, row.repoPath, IS_WINDOWS);
    // needsAttention 恒 0：黄点归顶栏收件箱，树里只认「此刻在跑」
    const running =
      projectRailStatus({
        isWindows: IS_WINDOWS,
        needsAttention: 0,
        roots: [
          row.repoPath,
          ...repos
            .filter((w) => samePath(w.repoPath, row.repoPath, IS_WINDOWS))
            .map((w) => w.worktreePath),
        ],
        runs: terminalRunInputs,
      }) === "running";
    const menuOpen = menu?.row.key === row.key;
    // 拖动：源行跟手；落在「原位 → 目标」之间的行各让一个槽位（同运行页标签条）
    const inSection = drag?.section === section ? drag : null;
    const isSource = inSection?.key === row.key;
    let shift = 0;
    if (inSection && !isSource) {
      const { from, target, slots } = inSection;
      if (from < target && index > from && index <= target)
        shift = slots[index - 1].left - slots[index].left;
      else if (from > target && index < from && index >= target)
        shift = slots[index + 1].left - slots[index].left;
    }
    return (
      <div
        key={row.key}
        data-tree-row={row.key}
        onPointerDown={(e) => onRowPointerDown(e, section, paths, row.key)}
        style={
          inSection
            ? {
                transform: `translateY(${isSource ? inSection.dy : shift}px)`,
                transition:
                  !isSource || inSection.settling ? "transform 150ms ease" : "none",
              }
            : undefined
        }
        className={`group relative flex h-7 items-center rounded-md transition-colors ${
          isSource ? "z-10 bg-raised" : ""
        } ${
          selected && active
            ? "ccode-tree-active bg-rail-sel"
            : menuOpen
              ? "bg-hover"
              : "hover:bg-hover"
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, row });
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            onSelect(row.repoPath);
          }}
          title={row.repoPath}
          aria-current={selected && active ? "page" : undefined}
          className={`flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-xs ${
            selected && active
              ? "font-medium text-l1"
              : selected
                ? "font-medium text-l2 group-hover:text-l1"
                : "text-l3 group-hover:text-l2"
          }`}
        >
          {running ? (
            <span className="size-1.5 shrink-0 rounded-full bg-ok-text" title="运行中" />
          ) : (
            <span className="size-1.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{row.name}</span>
        </button>
        <button
          type="button"
          aria-label={`${row.name} 的更多操作`}
          title="更多操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          // ⋯ 上按下不起拖
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.bottom + 4, row, alignRight: true });
          }}
          className={`mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 transition-opacity hover:bg-hover hover:text-l1 focus-visible:opacity-100 ${
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const showSearch = searchOpen || searchQuery !== "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 项目标签行：计数 + 搜索 + 添加菜单（添加流程与示例课题创建都在项目页，经一次性请求触发） */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2">
        <span className="text-micro font-medium tracking-[0.08em] text-l3">
          项目
        </span>
        <span className="text-micro text-l4">{rows.length}</span>
        <span className="ml-auto flex items-center">
          {(rows.length > SEARCH_MIN || searchQuery) && (
            <button
              type="button"
              // 按下时不抢焦点：否则输入框先失焦收起，紧接着这次点击又把它打开
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSearchOpen((v) => !v || searchQuery !== "")}
              title="搜索项目"
              aria-label="搜索项目"
              aria-expanded={showSearch}
              className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-l1 ${
                showSearch ? "text-l1" : "text-l3"
              }`}
            >
              <Search size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setAddMenu({ x: rect.right - 176, y: rect.bottom + 4 });
            }}
            title="添加项目 / 创建示例课题"
            aria-label="添加项目 / 创建示例课题"
            className="flex h-6 w-6 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </span>
      </div>

      {showSearch && (
        <div className="shrink-0 px-1.5 pb-2 pt-1">
          <div className="ccode-rail-search ccode-search-shell flex h-7 items-center gap-1.5 rounded-md px-2">
            <Search size={13} strokeWidth={1.8} className="shrink-0 text-l3" />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => {
                if (!searchQuery) setSearchOpen(false);
              }}
              placeholder="搜索项目"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  setSearchOpen(false);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-xs text-l1 outline-none placeholder:text-l3"
            />
            <button
              type="button"
              // 按下就处理，抢在输入框失焦之前，免得空框先被 onBlur 收走
              onMouseDown={(e) => {
                e.preventDefault();
                setSearchQuery("");
                setSearchOpen(false);
              }}
              className="shrink-0 text-l4 hover:text-l1"
              aria-label="关闭搜索"
              title="关闭搜索（Esc）"
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-1">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-l4">
            还没有项目，点上面的 ＋ 添加
          </p>
        ) : grouped.pinned.length === 0 && grouped.groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-l4">没有匹配的项目</p>
        ) : (
          <>
            {grouped.pinned.length > 0 && (
              <div className="mb-1">
                {/* 不写 text-xs：分组组头是 button，全站 button { font: inherit } 让它吃侧栏字号，
                    这里是 div，写了反而比「科研 / 编程」小一号 */}
                <div className="flex h-7 items-center gap-1.5 px-2 text-l3">
                  <Pin size={13} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">置顶</span>
                </div>
                <div className="ml-3 space-y-0.5 border-l border-hairline pl-1.5">
                  {grouped.pinned.map((r, i, all) =>
                    renderRow(r, i, "pinned", all.map((x) => x.repoPath)),
                  )}
                </div>
              </div>
            )}
            {grouped.groups.map((group) => {
              const isExpanded = expandedGroups.has(group.mode);
              const Icon = isExpanded ? ChevronDown : ChevronRight;
              return (
                <div key={group.mode} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.mode)}
                    className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-xs text-l3 hover:bg-hover hover:text-l2"
                  >
                    <Icon size={13} strokeWidth={1.8} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {RAIL_WORK_MODE_LABEL[group.mode]}
                    </span>
                    {/* 展开时子项就在下面，数字是重复信息；收起才报有几个 */}
                    {!isExpanded && (
                      <span className="shrink-0 text-micro text-l4">
                        {group.items.length}
                      </span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="ml-3 space-y-0.5 border-l border-hairline pl-1.5">
                      {group.items.map((r, i, all) =>
                        renderRow(r, i, group.mode, all.map((x) => x.repoPath)),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight={menu.alignRight}
          onClose={() => setMenu(null)}
          items={menuItems(menu.row)}
        />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          items={[
            {
              label: "新建项目…",
              icon: FolderPlus,
              title: "起个名字建一个新文件夹，定好工作方式后登记为项目",
              onSelect: () => {
                const s = useAppStore.getState();
                s.setPage("workspaces");
                s.setNewProjectOpenReq({ token: Date.now() });
              },
            },
            {
              label: "添加已有文件夹…",
              icon: FolderOpen,
              title: "把电脑上已有的文件夹登记为项目",
              onSelect: () => {
                const s = useAppStore.getState();
                s.setPage("workspaces");
                s.setAddProjectOpenReq(Date.now());
              },
            },
            {
              label: "创建示例课题",
              icon: Sparkles,
              hint: "演示",
              title: "在 文档/Mesa 示例课题 生成带演示数据的完整研究流程项目。以前建在「Ccode 示例课题」里的，再点仍打开那一份",
              onSelect: () => {
                const s = useAppStore.getState();
                s.setPage("workspaces");
                s.setDemoProjectOpenReq(Date.now());
              },
            },
          ]}
        />
      )}
      {renameTarget && (
        <RenameProjectModal
          path={renameTarget.path}
          initialName={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRenamed={() => {
            setRenameTarget(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** 切换面板「最近」段：课题超过这个数才单列最近打开的几个（少时分组本身一眼看完） */
const RECENT_MIN_TOTAL = 8;
const RECENT_COUNT = 5;

type SwitchRow = {
  project: ProjectDto;
  running: boolean;
  current: boolean;
};

/** 命中片段加亮：不区分大小写，只亮第一处（课题名短，多处命中少见） */
function HighlightName({ name, query }: { name: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <span className="font-semibold text-l1">
        {name.slice(at, at + q.length)}
      </span>
      {name.slice(at + q.length)}
    </>
  );
}

/** 项目切换面板的开关与数据：打开时现拉课题清单与工作区（运行绿点要认工作树），
 *  返回 open(锚点) 与要挂载的面板元素。由顶栏项目芯片使用（侧栏收起 / 隐藏时的唯一切换入口）。 */
export function useProjectSwitch(
  selectedRoot: string | null,
  onSelect: (repoPath: string) => void,
) {
  const [panel, setPanel] = useState<{
    left: number;
    top: number;
    rows: SwitchRow[];
  } | null>(null);

  async function open(pos: { left: number; top: number }) {
    try {
      const [projects, workspaces] = await Promise.all([
        invoke<ProjectDto[]>("list_projects"),
        invoke<Pick<WorkspaceDto, "repoPath" | "worktreePath">[]>(
          "list_workspaces",
        ).catch(() => []),
      ]);
      const runs = useAppStore.getState().terminalRunInputs;
      const rows = projects.map((p) => ({
        project: p,
        current:
          selectedRoot != null && samePath(selectedRoot, p.path, IS_WINDOWS),
        running:
          projectRailStatus({
            isWindows: IS_WINDOWS,
            needsAttention: 0,
            roots: [
              p.path,
              ...workspaces
                .filter((w) => samePath(w.repoPath, p.path, IS_WINDOWS))
                .map((w) => w.worktreePath),
            ],
            runs,
          }) === "running",
      }));
      setPanel({ ...pos, rows });
    } catch (reason) {
      toast(`读取项目列表失败：${String(reason)}`, "error");
    }
  }

  const element = panel ? (
    <ProjectSwitchPanel
      left={panel.left}
      top={panel.top}
      rows={panel.rows}
      onClose={() => setPanel(null)}
      onPick={(path) => {
        setPanel(null);
        onSelect(path);
      }}
    />
  ) : null;
  return { open, isOpen: !!panel, element };
}

/** 顶栏左侧的项目芯片（侧栏收起 / 隐藏时才出现，规则见 shell-context.ts）：
 *  点名字＝回到这个课题（已在项目页时改为打开切换面板），点 ⌄＝切换面板。
 *  没有当前课题时只剩「选择项目」，点开即切换面板。 */
export function TitlebarProjectChip({
  name,
  path,
  onProjectPage,
  onSelect,
}: {
  name: string | null;
  path: string | null;
  onProjectPage: boolean;
  onSelect: (repoPath: string) => void;
}) {
  const sw = useProjectSwitch(path, onSelect);
  const anchorRef = useRef<HTMLDivElement>(null);
  const openSwitch = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) void sw.open({ left: r.left, top: r.bottom + 6 });
  };
  return (
    <div
      ref={anchorRef}
      className={`flex h-6 min-w-0 shrink items-center rounded-md ${
        sw.isOpen ? "bg-hover" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => {
          if (path && !onProjectPage) onSelect(path);
          else openSwitch();
        }}
        title={
          path
            ? onProjectPage
              ? `当前项目：${name}（点击切换）`
              : `回到「${name}」`
            : "选择项目"
        }
        className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-l-md pl-2 pr-1 text-micro text-l2 hover:bg-hover hover:text-l1"
      >
        <Folder size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l3" />
        <span className="min-w-0 truncate">{name ?? "选择项目"}</span>
      </button>
      <button
        type="button"
        onClick={openSwitch}
        aria-label="切换项目"
        aria-haspopup="dialog"
        aria-expanded={sw.isOpen}
        className="flex h-6 shrink-0 items-center rounded-r-md px-1 text-l3 hover:bg-hover hover:text-l1"
      >
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {sw.element}
    </div>
  );
}

function ProjectSwitchPanel({
  left,
  top,
  rows,
  onClose,
  onPick,
}: {
  left: number;
  top: number;
  rows: SwitchRow[];
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const { dismiss, exiting } = useAnimatedDismiss(onClose);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* 缺省全展开 */
    }
    return new Set(["research", "coding", "office"]);
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left, top });

  // 实测面板高度后钳进视口（按钮靠下时整块上移，不被窗口底切掉）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPos({
      left: Math.min(left, window.innerWidth - el.offsetWidth - 8),
      top: Math.max(8, Math.min(top, window.innerHeight - el.offsetHeight - 8)),
    });
  }, [left, top]);

  const q = query.trim().toLowerCase();
  // 段落模型：搜索时一段扁平结果；否则「最近」(课题多时) + 各工作方式分组
  const sections = useMemo(() => {
    if (q) {
      return [
        {
          key: "result",
          label: null as string | null,
          collapsible: false,
          items: rows.filter(
            (r) =>
              r.project.name.toLowerCase().includes(q) ||
              r.project.path.toLowerCase().includes(q),
          ),
        },
      ];
    }
    const out: {
      key: string;
      label: string | null;
      collapsible: boolean;
      items: SwitchRow[];
    }[] = [];
    if (rows.length > RECENT_MIN_TOTAL) {
      // list_projects 已按最近打开降序
      out.push({
        key: "recent",
        label: "最近",
        collapsible: false,
        items: rows.slice(0, RECENT_COUNT),
      });
    }
    // 分组内顺序与侧栏项目树同一张表（拖动排序的结果），两边不各排各的；「最近」段仍按打开时间
    let order: string[] = [];
    try {
      order = parsePins(localStorage.getItem(PROJECT_ORDER_KEY));
    } catch {
      /* 读不出就按最近打开 */
    }
    const ordered = applyOrder(rows, order, (r) => r.project.path, IS_WINDOWS);
    for (const g of groupByWorkMode(ordered, (r) => r.project.workMode)) {
      out.push({
        key: g.mode,
        label: RAIL_WORK_MODE_LABEL[g.mode],
        collapsible: true,
        items: g.items,
      });
    }
    return out;
  }, [rows, q]);

  // 键盘可达的行（折叠组里的不算）
  const flat = sections.flatMap((sec) =>
    sec.collapsible && !expanded.has(sec.key)
      ? []
      : sec.items.map((r) => ({ sec: sec.key, row: r })),
  );
  const clamped = Math.min(cursor, Math.max(flat.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        /* 存不下只影响下次 */
      }
      return next;
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else dismiss();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setCursor((clamped + d + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[clamped];
      if (hit) onPick(hit.row.project.path);
    }
  }

  let idx = -1;
  // 挂到 body：顶栏芯片 / 侧栏按钮的祖先可能带 transform 或 backdrop-filter（会改 fixed 定位基准）
  return createPortal(
    <div
      className={`fixed inset-0 z-50${exiting ? " ccode-exiting" : ""}`}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label="切换项目"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={pos}
        className={`ccode-anchor-topleft ccode-float-surface absolute flex w-72 flex-col rounded-lg border border-field${exiting ? " ccode-exiting" : ""}`}
      >
        <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
          <span className="text-xs font-medium text-l1">项目</span>
          <span className="text-micro text-l3">{rows.length}</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              const s = useAppStore.getState();
              s.setPage("workspaces");
              s.setAddProjectOpenReq(Date.now());
            }}
            title="添加项目"
            aria-label="添加项目"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
          >
            <FolderPlus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="shrink-0 px-2 pb-2">
          <div className="ccode-rail-search ccode-search-shell flex h-8 items-center gap-2 rounded-md px-2.5">
            <Search size={13} strokeWidth={1.8} className="shrink-0 text-l3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder="搜索项目…"
              aria-label="搜索项目"
              className="min-w-0 flex-1 bg-transparent text-xs text-l1 outline-none placeholder:text-l3"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清除"
                className="shrink-0 text-l3 hover:text-l1"
              >
                <X size={13} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
        <div
          ref={listRef}
          className="max-h-[min(26rem,62vh)] overflow-y-auto border-t border-hairline px-1.5 pb-1.5 pt-1"
        >
          {rows.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-xs text-l3">
              还没有项目，点右上角添加
            </p>
          ) : flat.length === 0 && q ? (
            <p className="px-2.5 py-6 text-center text-xs text-l3">
              没有匹配「{query.trim()}」的项目
            </p>
          ) : (
            sections.map((sec) => {
              const open = !sec.collapsible || expanded.has(sec.key);
              return (
                <div key={sec.key} className="pt-1">
                  {sec.label &&
                    (sec.collapsible ? (
                      <button
                        type="button"
                        onClick={() => toggle(sec.key)}
                        aria-expanded={open}
                        className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-micro text-l3 hover:text-l1"
                      >
                        {open ? (
                          <ChevronDown size={12} strokeWidth={1.8} />
                        ) : (
                          <ChevronRight size={12} strokeWidth={1.8} />
                        )}
                        <span className="flex-1 text-left">{sec.label}</span>
                        <span>{sec.items.length}</span>
                      </button>
                    ) : (
                      <div className="flex h-6 items-center px-2 text-micro text-l3">
                        {sec.label}
                      </div>
                    ))}
                  {open &&
                    sec.items.map((r) => {
                      idx += 1;
                      const i = idx;
                      const on = i === clamped;
                      return (
                        <button
                          key={`${sec.key}:${r.project.path}`}
                          type="button"
                          data-idx={i}
                          title={r.project.path}
                          onMouseMove={() => {
                            if (cursor !== i) setCursor(i);
                          }}
                          onClick={() => onPick(r.project.path)}
                          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs ${
                            on ? "bg-hover" : ""
                          } ${r.current ? "font-medium text-l1" : "text-l2"}`}
                        >
                          <Folder
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden="true"
                            className={`shrink-0 ${r.current ? "text-nav-accent" : "text-l3"}`}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <HighlightName name={r.project.name} query={query} />
                          </span>
                          {q && (
                            <span className="shrink-0 text-micro text-l3">
                              {
                                RAIL_WORK_MODE_LABEL[
                                  normalizeWorkMode(r.project.workMode)
                                ]
                              }
                            </span>
                          )}
                          {r.running && (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-ok-text"
                              title="有 Agent 在跑"
                            />
                          )}
                          {r.current && (
                            <Check
                              size={13}
                              strokeWidth={1.8}
                              aria-hidden="true"
                              className="shrink-0 text-l3"
                            />
                          )}
                        </button>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
