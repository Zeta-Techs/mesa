/**
 * 聊天空态纯逻辑（2026-10-17 用户选定，同日二轮收敛为「输入框居中」，避免长成第二个工作台）。
 * 画布中央不写引导语、不铺点阵（v3.214 否决过）。空态时问候 + 输入框居中，下面一排按目录类型给的起手提示
 * （恢复占位标签再加「上次的对话还没接回」）。找旧对话归工作台 / 对话页，这里不列。
 * 起手提示点了只填进输入框，不替用户发送。
 */
import { samePath } from "./path-utils.ts";
import { isScratchCwd } from "./quick-chat.ts";
import { normalizeWorkMode, type WorkMode } from "./work-mode.ts";

export type StarterContext = WorkMode | "general";

export interface StarterPrompt {
  /** 芯片上的短标签 */
  label: string;
  /** 填进输入框的完整句子：说清要什么、交付成什么样，用户可以再改 */
  text: string;
}

export const STARTER_PROMPTS: Record<StarterContext, readonly StarterPrompt[]> = {
  research: [
    {
      label: "梳理课题进度",
      text: "梳理一下这个课题现在的进度：已经做完了什么、卡在哪里、下一步最该做什么。",
    },
    {
      label: "把新文献做成笔记",
      text: "看看 papers/ 里还有哪些文献没有笔记，挑最相关的一篇读完，按精读笔记的格式写进 notes/。",
    },
    {
      label: "检查引用是否齐全",
      text: "检查正文里引用的文献在 references.bib 里是否都有条目，列出缺的和没被用到的。",
    },
    {
      label: "起草下一节",
      text: "根据现有的笔记和大纲，起草下一节的初稿；没有依据的论断标出来，不要编造文献。",
    },
  ],
  coding: [
    { label: "讲讲代码结构", text: "通读这个仓库，讲讲整体结构：入口在哪、主要模块各管什么。" },
    { label: "找最近改动的问题", text: "看看最近的改动（git diff 和最近几次提交），找出可能的 bug 或遗漏。" },
    { label: "补测试", text: "找出最缺测试的关键逻辑，补上测试并跑通。" },
    { label: "解释一个报错", text: "帮我看这个报错是怎么回事、该怎么修：\n" },
  ],
  office: [
    { label: "整理这个目录", text: "看看这个目录里有哪些文件，按用途给出整理建议，先别动文件。" },
    { label: "改得更简洁", text: "把这份文档改得更简洁、更好读，保留原意：\n" },
    { label: "做汇报大纲", text: "根据这个目录里的材料，做一份 10 分钟汇报的大纲。" },
  ],
  general: [
    { label: "解释一个概念", text: "用通俗的话解释一下：\n" },
    { label: "写个小脚本", text: "帮我写一个脚本，用来：\n" },
    { label: "看懂一段报错", text: "这段报错是什么意思、该怎么处理：\n" },
    { label: "润色一段文字", text: "帮我润色下面这段文字，保留原意、更专业：\n" },
  ],
};

/** 「~」与空串展开成家目录，其余原样 */
export function resolveChatCwd(cwd: string | null | undefined, home: string): string {
  const raw = (cwd ?? "").trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/") && home) return `${home.replace(/[\\/]+$/, "")}/${raw.slice(2)}`;
  return raw;
}

/** 目录属于哪类：已登记项目按其工作方式；家目录 / 随手聊目录 / 未登记目录给通用提示 */
export function starterContextFor(
  cwd: string,
  projects: readonly { path: string; workMode?: string | null }[],
  isWindows = false,
): StarterContext {
  if (!cwd || isScratchCwd(cwd, isWindows)) return "general";
  const hit = projects.find((p) => samePath(p.path, cwd, isWindows));
  return hit ? normalizeWorkMode(hit.workMode) : "general";
}

export interface ProjectStarter {
  name: string;
  path: string;
}

/** 通用空态最多放几个「接着做某项目」：剩下的位置留给通用起手提示，一排总数不变 */
export const PROJECT_STARTER_LIMIT = 2;

/**
 * 通用空态的「接着做」（2026-10-23 运行页审查，用户拍板）：通用起手提示放进任何聊天应用都成立，
 * Mesa 自己的东西是项目——列最近有过对话的已登记项目（不含当前目录、不算 Mesa 内部对话），
 * 按最近一次对话时间倒序；没有对话的项目按上次打开时间兜底。点了只把这段对话的目录换到该项目，不替用户发送。
 */
export function recentProjectStarters(
  projects: readonly { path: string; name: string; lastOpenedAt?: string | null }[],
  sessions: readonly { projectPath: string; updatedAt: string | null; internal?: boolean }[],
  currentDir: string,
  isWindows = false,
  limit = PROJECT_STARTER_LIMIT,
): ProjectStarter[] {
  const ranked = projects
    .filter((p) => !(currentDir && samePath(p.path, currentDir, isWindows)))
    .map((p) => {
      let last = "";
      for (const s of sessions) {
        if (s.internal || !s.updatedAt) continue;
        if (s.updatedAt > last && samePath(s.projectPath, p.path, isWindows)) last = s.updatedAt;
      }
      return { p, last: last || p.lastOpenedAt || "" };
    })
    .filter((r) => r.last)
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  return ranked.slice(0, limit).map(({ p }) => ({ name: p.name, path: p.path }));
}

/** 空态问候（2026-10-17 用户选定「品牌标志 + 问候」）：只按时段，不写身份、不重复输入框占位 */
export function chatGreeting(hour: number): string {
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 23) return "晚上好";
  return "夜深了";
}

