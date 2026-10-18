/**
 * 终端未启动空态：卡上目录文案与底栏收口纯逻辑（无 DOM）。
 * 身份（agent / 配置 / 模型）只活在启动栏；卡上只回答「在这个目录运行」。
 */
import { abbrevHome, samePath } from "./path-utils.ts";

/** 无存活 PTY = 未启动（含刚挂载、status 尚未上报）。 */
export function isTerminalIdle(
  status: { ptyId?: string | null } | null | undefined,
): boolean {
  return !status?.ptyId;
}

/** 空态卡上的目录短名：家目录折 ~；空串与裸 ~ 都显示 ~。 */
export function welcomeCwdShown(
  cwd: string,
  home: string,
  isWindows = false,
): string {
  const raw = cwd.trim() || "~";
  if (raw === "~") return "~";
  return home ? abbrevHome(raw, home, isWindows) : raw;
}

/** 「将在 {短名} {动词}」——终端空态卡用（聊天输入框 2026-10-17 起改为目录芯片 cwdChipLabel）。 */
export function welcomeCwdLine(
  cwd: string,
  home: string,
  verb: "启动" | "恢复",
  isWindows = false,
): string {
  return `将在 ${welcomeCwdShown(cwd, home, isWindows)} ${verb}`;
}

/** 「将在 {短名} 启动/恢复」——终端空态卡目录行。 */
export function welcomeCwdActionLabel(
  cwd: string,
  home: string,
  restored: boolean,
  isWindows = false,
): string {
  return welcomeCwdLine(cwd, home, restored ? "恢复" : "启动", isWindows);
}

/**
 * 主目录文件树自动收起，只做一次。
 * 人已经点过「显示文件树」时 handled 为 true，这次必须保持打开。
 * 离开主目录时 handled 复位，下次再落到主目录可以再收一次。
 */
export function collapseHomeTreeOnce(
  atHome: boolean,
  treeOpen: boolean,
  handled: boolean,
): { open: boolean; handled: boolean } {
  if (!atHome) return { open: treeOpen, handled: false };
  if (treeOpen && !handled) return { open: false, handled: true };
  return { open: treeOpen, handled };
}

/** 未启动且目录是家/裸 ~ 时，标签不要显示成 ~。 */
export function idleTabTitle(cwd: string, idle: boolean): string | null {
  if (!idle) return null;
  const raw = cwd.trim() || "~";
  if (raw === "~") return "未启动";
  const base = raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? raw;
  if (base === "~") return "未启动";
  return null;
}

export interface WelcomeDirChoice {
  path: string;
  label: string;
  kind: "scratch" | "project" | "home";
  current: boolean;
}

/**
 * 空态卡「将在 … 启动」点开的目录菜单（2026-10-17）：原先一点就弹系统选目录窗，
 * 而新标签默认落在主目录——想去的通常是随手聊或某个已添加项目，得一层层点。
 * 顺序：随手聊 → 已添加项目（按最近活动，最多 limit 个）→ 主目录；菜单尾部另有「选择文件夹…」。
 */
export function welcomeDirChoices(input: {
  cwd: string;
  home: string;
  projectPaths: readonly string[];
  recentRepos?: readonly { path: string; name: string; lastActive?: string | null }[];
  isWindows?: boolean;
  limit?: number;
}): WelcomeDirChoice[] {
  const isWindows = input.isWindows ?? false;
  const home = input.home.trim();
  if (!home) return [];
  const sep = isWindows ? "\\" : "/";
  const base = home.replace(/[\\/]+$/, "");
  const raw = input.cwd.trim();
  const current =
    !raw || raw === "~" ? home : raw.startsWith("~") ? `${base}${raw.slice(1)}` : raw;
  const isCurrent = (path: string) => samePath(path, current, isWindows);
  const recent = input.recentRepos ?? [];
  const lastOf = (path: string) =>
    recent.find((repo) => samePath(repo.path, path, isWindows))?.lastActive ?? "";
  const nameOf = (path: string) =>
    recent.find((repo) => samePath(repo.path, path, isWindows))?.name?.trim() ||
    path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ||
    path;
  const projects = [...input.projectPaths]
    .sort((a, b) => (lastOf(b) > lastOf(a) ? 1 : lastOf(b) < lastOf(a) ? -1 : 0))
    .slice(0, input.limit ?? 6);
  const scratch = `${base}${sep}ccode${sep}scratch`;
  return [
    { path: scratch, label: "随手聊", kind: "scratch", current: isCurrent(scratch) },
    ...projects.map((path) => ({
      path,
      label: nameOf(path),
      kind: "project" as const,
      current: isCurrent(path),
    })),
    { path: home, label: "主目录", kind: "home", current: isCurrent(home) },
  ];
}

/** 聊天输入框底栏的目录芯片文字（2026-10-17 用户：「将在 ~ 开始」应该是选项目）：
 *  已添加项目显示项目名，随手聊 / 主目录写白话，其余写文件夹名 */
export function cwdChipLabel(input: {
  cwd: string;
  home: string;
  projectPaths: readonly string[];
  recentRepos?: readonly { path: string; name: string }[];
  isWindows?: boolean;
}): string {
  const isWindows = input.isWindows ?? false;
  const raw = input.cwd.trim();
  const home = input.home.trim();
  const base = home.replace(/[\\/]+$/, "");
  const current =
    !raw || raw === "~" ? home : raw.startsWith("~") && base ? `${base}${raw.slice(1)}` : raw;
  if (!current) return "主目录";
  if (home && samePath(current, home, isWindows)) return "主目录";
  const tail = current.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || current;
  if (/[\\/]ccode[\\/]scratch$/i.test(current.replace(/[\\/]+$/, ""))) return "随手聊";
  if (input.projectPaths.some((p) => samePath(p, current, isWindows))) {
    return (
      input.recentRepos?.find((r) => samePath(r.path, current, isWindows))?.name?.trim() || tail
    );
  }
  return tail;
}
