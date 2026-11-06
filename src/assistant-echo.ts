/**
 * 项目助手派活回音（2026-11-05 用户「让它真正像个助手」）：派出去的活做完、失败、停了，
 * 项目助手在那个项目的问答里补一条，同时进收件箱「项目助手」；不弹窗（少占注意力）。已验收是人自己点的，只记不说。
 * 纯逻辑，配 tests/assistant-echo.test.ts；巡视（调 invoke）在 assistant-echo-watch.ts。
 */
import type { DispatchPhase, DispatchRecord } from "./assistant-dispatch";
import type { InboxItem } from "./store";

export function echoText(rec: Pick<DispatchRecord, "target" | "step" | "title" | "mode">, phase: DispatchPhase): string {
  const what = rec.target === "step" ? `派给第 ${rec.step} 步的「${rec.title}」` : `派出去的「${rec.title}」`;
  switch (phase) {
    case "review":
      return rec.target === "step"
        ? `${what}做完了，等你评审、保存进项目。[[去评审:${rec.step}]]`
        : `${what}做完了，在项目页的待验收里等你验收。[[项目页]]`;
    case "failed":
      return rec.target === "goal"
        ? `${what}没做成（上次运行失败）。想知道原因可以直接问我「为什么失败了」；要接着做，点下面的「接着做」。`
        : `${what}没做成（上次运行失败）。想知道原因可以直接问我「为什么失败了」。`;
    case "stopped":
      return rec.target === "goal"
        ? `${what}停下了，没做完。要接着做，点下面的「接着做」（接回上次的隔离副本和对话）。`
        : `${what}停下了，没做完。要接着做，到那一步点「继续」。[[看这一步:${rec.step}]]`;
    case "accepted":
      return "";
  }
}

/** 已看过的回音：项目根 → 最后一次打开它的项目助手的时间（本机记） */
export const ECHO_SEEN_KEY = "ccode.assistantEchoSeen";

export function loadEchoSeen(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ECHO_SEEN_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function markEchoSeen(projectRoot: string, at = new Date().toISOString()): void {
  try {
    const seen = loadEchoSeen();
    seen[projectRoot] = at;
    localStorage.setItem(ECHO_SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* 记不下只是收件箱多留一会 */
  }
}

export interface OpenDispatch {
  projectRoot: string;
  turnAt: string;
  record: DispatchRecord;
}

/** 还没看过的回音 → 收件箱条目（只有做完等评审 / 验收、失败、停了才进；打开那个项目的项目助手就算看过） */
export function echoInboxItems(
  open: readonly OpenDispatch[],
  seen: Readonly<Record<string, string>>,
  projectName: (root: string) => string,
): InboxItem[] {
  const out: InboxItem[] = [];
  for (const d of open) {
    const phase = d.record.echoed as DispatchPhase | null | undefined;
    if (!phase || phase === "accepted" || !d.record.echoedAt) continue;
    const seenAt = seen[d.projectRoot];
    if (seenAt && Date.parse(seenAt) >= Date.parse(d.record.echoedAt)) continue;
    const state = phase === "review" ? "做完了" : phase === "failed" ? "没做成" : "停下了";
    out.push({
      key: `asst:${d.projectRoot}:${d.turnAt}:${phase}`,
      dot: phase === "review" ? "bg-ok-text" : "bg-warn-text",
      text: `${projectName(d.projectRoot)} · 项目助手派的「${d.record.title}」${state}`,
      actionLabel: "去看看",
      action: { type: "assistant", projectRoot: d.projectRoot },
    });
  }
  return out;
}
