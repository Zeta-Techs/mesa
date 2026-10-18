import { abbrevHome, parentDir } from "./path-utils.ts";
import type { StorageEntryDto } from "./types.ts";

/**
 * 设置 →「数据与存储」→「本机占用」卡的纯逻辑（2026-10-17）。
 *
 * 七行路径前缀一模一样，等宽长串占满整行却没有信息量：按归属分两组（Mesa 数据 / 工作副本），
 * 组头写一次根目录（家目录折成 ~），行里只写相对名；卡头给总计。
 */

export interface StorageRow extends StorageEntryDto {
  /** 组根下的相对名（目录带尾斜杠，便于一眼区分文件与目录） */
  rel: string;
}

export interface StorageGroup {
  /** 归属 + 组根目录：换过家目录位置后同一归属可有多个根，各自成组 */
  key: string;
  title: string;
  /** 组根目录（家目录已折成 ~） */
  rootLabel: string;
  /** 组根绝对路径（「定位」用） */
  rootPath: string;
  rows: StorageRow[];
}

export interface StorageSummary {
  total: number;
  /** 有条目统计提前收手：总计是下限 */
  totalApprox: boolean;
  groups: StorageGroup[];
}

/** 家目录：默认位置下工作副本条目在 ~/ccode/<名>，往上两级即是；仅在调用方没给真家目录时回退用 */
function homeFrom(entries: StorageEntryDto[]): string {
  const home = entries.find((e) => e.root === "home");
  if (!home) return "";
  return parentDir(parentDir(home.path) ?? "") ?? "";
}

function relName(path: string, root: string): string {
  const tail = path.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return tail || path;
}

const GROUP_TITLES: [StorageEntryDto["root"], string][] = [
  ["config", "Mesa 数据"],
  ["home", "工作副本"],
  ["home-old", "工作副本（旧位置，换位置前留下的）"],
];

/**
 * `homeDir`：真实用户家目录。工作副本家目录可被用户换到别的盘，此时不能再从条目路径反推家目录
 * （会把 D:\mesa 当成家目录、把组头错折成 ~/ccode），调用方应传入。
 */
export function summarizeStorage(
  entries: StorageEntryDto[],
  isWindows = false,
  homeDir = "",
): StorageSummary {
  const home = homeDir || homeFrom(entries);
  const groups: StorageGroup[] = [];
  for (const [root, title] of GROUP_TITLES) {
    const inRoot = entries.filter((e) => (e.root ?? "config") === root);
    const roots: string[] = [];
    for (const e of inRoot) {
      const r = parentDir(e.path) ?? e.path;
      if (!roots.includes(r)) roots.push(r);
    }
    for (const rootPath of roots) {
      const list = inRoot.filter((e) => (parentDir(e.path) ?? e.path) === rootPath);
      groups.push({
        key: `${root}|${rootPath}`,
        title,
        rootPath,
        rootLabel: home ? abbrevHome(rootPath, home, isWindows) : rootPath,
        rows: list.map((e) => {
          const rel = relName(e.path, rootPath);
          // 文件条目只有 app.db / profiles.json 两个，有扩展名；其余是目录
          return { ...e, rel: /\.[a-z]+$/i.test(rel) ? rel : `${rel}/` };
        }),
      });
    }
  }
  return {
    total: entries.reduce((sum, e) => sum + (e.exists ? e.bytes : 0), 0),
    totalApprox: entries.some((e) => e.approx),
    groups,
  };
}

export interface StorageSegment {
  key: string;
  /** 图例短名：去掉括号里的文件名，旧位置的条目带后缀 */
  label: string;
  bytes: number;
  /** 占总量百分比（0–100），用于条宽 */
  pct: number;
  /** 色阶序号；「其他」恒为 -1（灰） */
  tone: number;
}

/**
 * 「本机占用」条形图的分段：按大小从大到小取前 `max` 项，余下并成「其他」。
 * 不存在或 0 字节的条目不画。总量为 0 返回空，由调用方不渲染条。
 */
export function storageSegments(entries: StorageEntryDto[], max = 5): StorageSegment[] {
  const live = entries
    .filter((e) => e.exists && e.bytes > 0)
    .map((e) => ({
      key: e.path,
      label:
        e.label.replace(/[（(].*?[）)]/g, "").trim() +
        (e.root === "home-old" ? "（旧位置）" : ""),
      bytes: e.bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = live.reduce((sum, e) => sum + e.bytes, 0);
  if (total === 0) return [];
  const head = live.slice(0, max);
  const rest = live.slice(max);
  const out: StorageSegment[] = head.map((e, i) => ({
    ...e,
    pct: (e.bytes / total) * 100,
    tone: i,
  }));
  if (rest.length > 0) {
    const bytes = rest.reduce((sum, e) => sum + e.bytes, 0);
    out.push({ key: "~other", label: "其他", bytes, pct: (bytes / total) * 100, tone: -1 });
  }
  return out;
}

/** 清理确认文案：说清移走的是什么、丢了什么、怎么找回。目前后端白名单只有快照 */
export function storageClearConfirmText(id: string, label: string, size: string): string {
  const tail = "\n\n整个目录移进系统回收站，后悔了可以从回收站拖回原处。";
  switch (id) {
    case "snapshots":
      return (
        `清理「${label}」（${size}）？\n\n` +
        "这是你 pin 会话时复制的备份。原 CLI 里还在的会话照常能看；原文件已被 CLI 删掉、只靠快照撑着的那些会从对话列表里消失。" +
        "快照只在 pin 那一刻复制，清掉后这些会话就没有备份了，还想留的取消 pin 再 pin 一次。" +
        tail
      );
    default:
      return `清理「${label}」（${size}）？${tail}`;
  }
}
