/**
 * 外部终端弹窗的「上次打开项目」与「最近项目」目录选择纯逻辑：
 * 1. 独立持久化外部终端打开过的目录（ccode.externalTerminalDirs，按打开时间降序），
 *    不被 Mesa 内部流水线步骤 worktree（ccode/workspaces）或随手聊（ccode/scratch）覆盖；
 * 2. 手动浏览或输入并打开的任意目录（无论是否已注册为 Mesa 项目、是否为 Git 仓库）都会进入最近项目列表；
 * 3. 首次使用尚无外部记录时，合并已注册项目与 CLI 最近仓库按最近活动时间挑默认项目，并过滤内部隔离目录。
 */
import { pathKey, pathWithin, samePath, stripVerbatim } from "./path-utils.ts";
import { cwdBasename } from "./run-overview.ts";

export const EXTERNAL_TERMINAL_DIRS_KEY = "ccode.externalTerminalDirs";
export const MAX_STORED_EXTERNAL_DIRS = 20;
export const RECENT_EXTERNAL_PROJECTS_LIMIT = 8;

export interface ExternalRecentDir {
  path: string;
  openedAt: string;
}

export interface ExternalProjectCandidate {
  path: string;
  name: string;
}

export interface ExternalProjectRef {
  path: string;
  name: string;
  lastOpenedAt?: string | null;
  createdAt?: string | null;
}

export interface ExternalRepoRef {
  path: string;
  name: string;
  lastActive?: string | null;
}

export interface ExternalWorkspaceRef {
  repoPath: string;
  worktreePath: string;
}

/** 剥除首尾空白、Windows verbatim 前缀与多余尾斜杠（保留根 `/` 与盘符根 `C:\`） */
export function cleanDirPath(raw: string): string {
  const s = stripVerbatim(raw.trim());
  if (!s) return "";
  if (s === "/" || /^[A-Za-z]:[\\/]$/.test(s)) return s;
  return s.replace(/[\\/]+$/, "");
}

function isIsolatedWorktreePath(
  path: string,
  workspaces: readonly ExternalWorkspaceRef[],
  isWindows: boolean,
): boolean {
  const k = pathKey(path, isWindows);
  if (!k) return false;
  if (/\/ccode\/(workspaces|watch-worktrees)(\/|$)/.test(k)) return true;
  return workspaces.some(
    (w) => Boolean(w.worktreePath) && pathWithin(path, w.worktreePath, isWindows),
  );
}

/** 是否为 Mesa 内部隔离 worktree 或随手聊 scratch 目录 */
export function isInternalWorktreeOrScratch(
  path: string,
  workspaces: readonly ExternalWorkspaceRef[] = [],
  isWindows = false,
): boolean {
  const k = pathKey(path, isWindows);
  if (!k) return false;
  if (/\/ccode\/(workspaces|watch-worktrees|scratch)(\/|$)/.test(k)) return true;
  return isIsolatedWorktreePath(path, workspaces, isWindows);
}

/**
 * 把任意遗留 cwd 归一为项目目录：
 * - 若命中某个工作副本 worktree，映射回它的主项目 repoPath；
 * - 若仍是内部 workspaces / watch-worktrees / scratch 或主目录本身，返回空串（不冒充上次项目）。
 */
export function resolveProjectDirFromCwd(
  rawCwd: string | null | undefined,
  workspaces: readonly ExternalWorkspaceRef[] = [],
  homeDir?: string | null,
  isWindows = false,
): string {
  const cleaned = cleanDirPath(rawCwd ?? "");
  if (!cleaned || cleaned === "~") return "";
  if (homeDir && samePath(cleaned, homeDir, isWindows)) return "";

  const matchedWs = workspaces.find(
    (w) => Boolean(w.worktreePath) && pathWithin(cleaned, w.worktreePath, isWindows),
  );
  if (matchedWs?.repoPath) {
    const repo = cleanDirPath(matchedWs.repoPath);
    if (repo && (!homeDir || !samePath(repo, homeDir, isWindows))) {
      return repo;
    }
  }

  if (isInternalWorktreeOrScratch(cleaned, workspaces, isWindows)) return "";
  return cleaned;
}

function laterIso(a?: string | null, b?: string | null): string | null {
  const aa = a?.trim() || null;
  const bb = b?.trim() || null;
  if (!aa) return bb;
  if (!bb) return aa;
  return aa >= bb ? aa : bb;
}

/** 解析 localStorage 中的外部终端最近目录记录（损坏数据安全降级为空数组） */
export function parseExternalRecentDirs(
  raw: string | null | undefined,
  isWindows = false,
): ExternalRecentDir[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const normalized: ExternalRecentDir[] = [];
  for (const item of parsed) {
    let path = "";
    let openedAt = "";
    if (typeof item === "string") {
      path = cleanDirPath(item);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.path === "string") path = cleanDirPath(rec.path);
      if (typeof rec.openedAt === "string") openedAt = rec.openedAt.trim();
    }
    if (!path) continue;
    // 内部隔离 worktree 永不留在外部终端最近项目记录中
    if (/\/ccode\/(workspaces|watch-worktrees)(\/|$)/.test(pathKey(path, isWindows))) {
      continue;
    }
    const existingIdx = normalized.findIndex((e) => samePath(e.path, path, isWindows));
    if (existingIdx >= 0) {
      const prev = normalized[existingIdx];
      if (openedAt && (!prev.openedAt || openedAt > prev.openedAt)) {
        normalized[existingIdx] = { path, openedAt };
      }
      continue;
    }
    normalized.push({ path, openedAt });
  }

  normalized.sort((a, b) => {
    if (a.openedAt && b.openedAt && a.openedAt !== b.openedAt) {
      return b.openedAt.localeCompare(a.openedAt);
    }
    if (a.openedAt && !b.openedAt) return -1;
    if (!a.openedAt && b.openedAt) return 1;
    return 0;
  });

  return normalized.slice(0, MAX_STORED_EXTERNAL_DIRS);
}

/** 记录一次外部终端目录打开：置顶、跨方言去重、裁剪上限；若传入 worktree 路径则自动折回主项目 */
export function recordExternalRecentDir(
  existing: readonly ExternalRecentDir[],
  rawPath: string,
  nowIso: string,
  workspaces: readonly ExternalWorkspaceRef[] = [],
  isWindows = false,
): ExternalRecentDir[] {
  let target = cleanDirPath(rawPath);
  if (!target) return [...existing];

  const matchedWs = workspaces.find(
    (w) => Boolean(w.worktreePath) && pathWithin(target, w.worktreePath, isWindows),
  );
  if (matchedWs?.repoPath) {
    target = cleanDirPath(matchedWs.repoPath);
  }
  if (
    !target ||
    /\/ccode\/(workspaces|watch-worktrees)(\/|$)/.test(pathKey(target, isWindows))
  ) {
    return [...existing];
  }

  const next: ExternalRecentDir[] = [
    { path: target, openedAt: nowIso },
    ...existing.filter((e) => !samePath(e.path, target, isWindows)),
  ];
  return next.slice(0, MAX_STORED_EXTERNAL_DIRS);
}

function buildActivityRankedProjects(input: {
  projects: readonly ExternalProjectRef[];
  recentRepos?: readonly ExternalRepoRef[];
  workspaces?: readonly ExternalWorkspaceRef[];
  homeDir?: string | null;
  isWindows: boolean;
}): { path: string; name: string; lastActive: string | null; order: number }[] {
  const { projects, recentRepos = [], workspaces = [], homeDir, isWindows } = input;
  const merged: { path: string; name: string; lastActive: string | null; order: number }[] = [];
  let seq = 0;

  const skip = (p: string) => {
    if (!p || p === "~") return true;
    if (homeDir && samePath(p, homeDir, isWindows)) return true;
    return isInternalWorktreeOrScratch(p, workspaces, isWindows);
  };

  for (const p of projects) {
    const cleaned = cleanDirPath(p.path);
    if (skip(cleaned)) continue;
    if (merged.some((m) => samePath(m.path, cleaned, isWindows))) continue;
    const repo = recentRepos.find((r) => samePath(r.path, cleaned, isWindows));
    const name =
      p.name.trim() || repo?.name.trim() || cwdBasename(cleaned) || cleaned;
    const lastActive = laterIso(
      laterIso(p.lastOpenedAt, p.createdAt),
      repo?.lastActive,
    );
    merged.push({ path: cleaned, name, lastActive, order: seq++ });
  }

  for (const r of recentRepos) {
    const cleaned = cleanDirPath(r.path);
    if (skip(cleaned)) continue;
    if (merged.some((m) => samePath(m.path, cleaned, isWindows))) continue;
    const name = r.name.trim() || cwdBasename(cleaned) || cleaned;
    merged.push({
      path: cleaned,
      name,
      lastActive: r.lastActive?.trim() || null,
      order: seq++,
    });
  }

  merged.sort((a, b) => {
    if (a.lastActive && b.lastActive && a.lastActive !== b.lastActive) {
      return b.lastActive.localeCompare(a.lastActive);
    }
    if (a.lastActive && !b.lastActive) return -1;
    if (!a.lastActive && b.lastActive) return 1;
    return a.order - b.order;
  });

  return merged;
}

/**
 * 组装外部终端弹窗的「最近项目」胶囊列表：
 * 1. 本次弹窗内刚通过「浏览…」手动选中的目录（立即出现在首位并高亮）；
 * 2. 历次在外部终端打开过的目录（含手动选择打开的非注册目录，按打开时间降序）；
 * 3. 已注册项目 + CLI 最近仓库（按最近活动时间降序，过滤内部 worktree / scratch / 主目录）。
 */
export function buildRecentExternalProjects(input: {
  pickedDirs?: readonly string[];
  externalRecent: readonly ExternalRecentDir[];
  projects: readonly ExternalProjectRef[];
  recentRepos?: readonly ExternalRepoRef[];
  workspaces?: readonly ExternalWorkspaceRef[];
  homeDir?: string | null;
  isWindows?: boolean;
  limit?: number;
}): ExternalProjectCandidate[] {
  const isWindows = input.isWindows ?? false;
  const limit = input.limit ?? RECENT_EXTERNAL_PROJECTS_LIMIT;
  const projects = input.projects;
  const recentRepos = input.recentRepos ?? [];
  const workspaces = input.workspaces ?? [];

  const labelAndCanonical = (rawPath: string): ExternalProjectCandidate | null => {
    const cleaned = cleanDirPath(rawPath);
    if (!cleaned) return null;
    const proj = projects.find((p) => samePath(p.path, cleaned, isWindows));
    if (proj) {
      const pPath = cleanDirPath(proj.path) || cleaned;
      return {
        path: pPath,
        name: proj.name.trim() || cwdBasename(pPath) || pPath,
      };
    }
    const repo = recentRepos.find((r) => samePath(r.path, cleaned, isWindows));
    if (repo) {
      const rPath = cleanDirPath(repo.path) || cleaned;
      return {
        path: rPath,
        name: repo.name.trim() || cwdBasename(rPath) || rPath,
      };
    }
    return {
      path: cleaned,
      name: cwdBasename(cleaned) || cleaned,
    };
  };

  const out: ExternalProjectCandidate[] = [];
  const pushUnique = (rawPath: string) => {
    const item = labelAndCanonical(rawPath);
    if (!item) return;
    if (out.some((x) => samePath(x.path, item.path, isWindows))) return;
    out.push(item);
  };

  for (const d of input.pickedDirs ?? []) {
    if (isIsolatedWorktreePath(d, workspaces, isWindows)) continue;
    pushUnique(d);
  }

  for (const entry of input.externalRecent) {
    if (isIsolatedWorktreePath(entry.path, workspaces, isWindows)) continue;
    pushUnique(entry.path);
  }

  const ranked = buildActivityRankedProjects({
    projects,
    recentRepos,
    workspaces,
    homeDir: input.homeDir,
    isWindows,
  });
  for (const item of ranked) {
    pushUnique(item.path);
  }

  return out.slice(0, Math.max(0, limit));
}

/**
 * 计算「在外部终端打开」默认预填的工作文件夹：
 * 1. 优先用上次在外部终端打开过的目录（externalRecent[0]）；
 * 2. 尚无外部记录时，取已注册项目与 CLI 最近仓库中最近活动的项目；
 * 3. 再兜底当前项目上下文或遗留 lastLaunch.cwd（自动剥离/折回 worktree 与 scratch）。
 */
export function resolveDefaultExternalCwd(input: {
  externalRecent: readonly ExternalRecentDir[];
  projects: readonly ExternalProjectRef[];
  recentRepos?: readonly ExternalRepoRef[];
  workspaces?: readonly ExternalWorkspaceRef[];
  contextProjectPath?: string | null;
  legacyLastLaunchCwd?: string | null;
  homeDir?: string | null;
  isWindows?: boolean;
}): string {
  const isWindows = input.isWindows ?? false;
  const workspaces = input.workspaces ?? [];

  for (const entry of input.externalRecent) {
    if (isIsolatedWorktreePath(entry.path, workspaces, isWindows)) continue;
    const cleaned = cleanDirPath(entry.path);
    if (cleaned) return cleaned;
  }

  const ranked = buildActivityRankedProjects({
    projects: input.projects,
    recentRepos: input.recentRepos,
    workspaces,
    homeDir: input.homeDir,
    isWindows,
  });
  if (ranked[0]?.path) return ranked[0].path;

  const fromContext = resolveProjectDirFromCwd(
    input.contextProjectPath,
    workspaces,
    input.homeDir,
    isWindows,
  );
  if (fromContext) return fromContext;

  return resolveProjectDirFromCwd(
    input.legacyLastLaunchCwd,
    workspaces,
    input.homeDir,
    isWindows,
  );
}
