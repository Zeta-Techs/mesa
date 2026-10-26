import { invoke } from "@tauri-apps/api/core";
import { ORGANIZE_NOTES_PROMPT } from "./pipeline-presets";
import { notesExcerptTarget } from "./lit-project";
import { samePath } from "./path-utils";
import { IS_WINDOWS } from "./hotkeys";
import { stepSlotKey, taskBindingLaunch, workspaceLaunchChain } from "./project-agents";
import { useAppStore } from "./store";
import type { PdfActionResult } from "./components/PdfPreview";
import type { ProjectConfigReadDto, ProjectDto, WorkspaceDto } from "./types";

/**
 * PDF 选段「整理为笔记」（运行页右栏与项目文件页共用，2026-10-26 从 TerminalPage 抽出）：
 * 选段连同文件名、页码、日期追加到课题的 notes/excerpts.md；精读步正在跑时写进那一步的工作区，
 * 并在终端预填「把新摘的选段并进对应文献的笔记」（确认配置后人点启动）；精读没开工只写项目根，不替人开工。
 * PDF 不属于任何已添加课题时由 offerAddProject 问要不要把所在文件夹加成课题（运行页给；项目页的 PDF 本就在课题里）。
 */
export async function organizePdfExcerpt(input: {
  pdfPath: string;
  text: string;
  page: number;
  fileName: string;
  offerAddProject?: () => Promise<string | null>;
  /** 预填了终端启动之后（项目页调用时据此跳到运行页） */
  onLaunch?: () => void;
}): Promise<PdfActionResult> {
  const { pdfPath, text, page, fileName } = input;
  let owner = await invoke<ProjectDto | null>("pdf_owner_project", { pdfPath });
  if (!owner) {
    const root = input.offerAddProject ? await input.offerAddProject() : null;
    if (!root) return { ok: false, msg: "这份 PDF 不在已添加的课题里，笔记没有写入" };
    owner = { path: root, name: "", createdAt: null, lastOpenedAt: null };
  }
  const read = await invoke<ProjectConfigReadDto>("read_project_config", {
    path: owner.path,
  });
  const cfg = read.config;
  const date = new Date().toLocaleDateString("sv-SE");
  const chunk = `\n## ${fileName} · 第 ${page} 页 · ${date}\n\n${text}\n`;
  const target = notesExcerptTarget(cfg);
  const step =
    target.kind === "workspace"
      ? cfg.steps.find((s) => s.workspaceName === target.name)
      : undefined;
  const all =
    target.kind === "workspace" ? await invoke<WorkspaceDto[]>("list_workspaces") : [];
  const ws = all.find(
    (w) =>
      samePath(w.repoPath, owner.path, IS_WINDOWS) &&
      target.kind === "workspace" &&
      w.name === target.name &&
      w.status === "active",
  );
  if (!ws || !step) {
    await invoke("append_notes_excerpt", {
      worktreePath: owner.path,
      content: chunk,
    });
    return {
      ok: true,
      msg: step
        ? `已写入项目 notes/excerpts.md。「${step.name}」开工时会带进工作区，AI 精读到这篇时并进笔记。`
        : "已写入项目 notes/excerpts.md。可在右边「文件」里打开这份摘录继续写。",
    };
  }
  await invoke("append_notes_excerpt", {
    worktreePath: ws.worktreePath,
    content: chunk,
  });
  const pairs = await invoke<[string, string][]>("workspace_env_for", {
    worktreePath: ws.worktreePath,
  });
  const last = (() => {
    try {
      return JSON.parse(
        localStorage.getItem(`ccode.wsLast.${ws.worktreePath}`) ?? "{}",
      ) as Partial<{ agentId: string; profileId: string; model: string }>;
    } catch {
      return {};
    }
  })();
  // B1：整理笔记是步骤工作区启动——步骤槽绑定优先于 wsLast（workspaceLaunchChain
  // 与 buildWorkspaceTerminalRequest 同一纯链，免两处顺序漂移）；绑定现读，
  // 读不到按未绑定走 wsLast 现状
  let stepL: { agentId: string; profileId: string; model: string } | null = null;
  try {
    const b = await invoke<{ profile: string; model?: string | null } | null>(
      "get_project_agent_binding",
      {
        projectRoot: owner.path,
        slot: stepSlotKey(step.name),
      },
    );
    stepL = taskBindingLaunch(useAppStore.getState().profiles, b);
  } catch {
    /* 读不到按未绑定回落 */
  }
  const chain = workspaceLaunchChain(null, stepL, last);
  const st = useAppStore.getState();
  st.setPendingTerminal({
    cwd: ws.worktreePath,
    extraEnv: Object.fromEntries(pairs),
    title: ws.name,
    agentId: chain.agentId,
    profileId: chain.profileId,
    model: chain.model,
    initialPrompt: ORGANIZE_NOTES_PROMPT,
  });
  input.onLaunch?.();
  return {
    ok: true,
    msg: `已写入工作区「${ws.name}」的 notes/excerpts.md，并预填了终端启动（确认配置后点「启动」）`,
  };
}
