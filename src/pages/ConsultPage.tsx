import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConsultView from "../components/ConsultView";
import { EmptyState } from "../components/PageFrame";
import { useAppStore } from "../store";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";

/**
 * 研讨页（2026-11-11 用户：研讨放在聊天层那一格，从对话切过去不用进对话管理）：主区只放一场研讨的视图，
 * 打开哪一场看 store.consultOpen（侧栏课题下的研讨行、「去看看」、工作台进行中的研讨经 showConsult 设）。
 * 不是侧栏九页之一，导航里没有它；对话管理里的研讨一组照旧，是翻历史的地方
 */
export default function ConsultPage({ visible }: { visible: boolean }) {
  const open = useAppStore((s) => s.consultOpen);
  const closeConsult = useAppStore((s) => s.closeConsult);
  const openConsult = useAppStore((s) => s.openConsult);
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !open) return;
    let stale = false;
    void invoke<{ path: string; name: string }[]>("list_projects")
      .then((list) => {
        if (!stale) setProjectName(list.find((p) => samePath(p.path, open.projectRoot, IS_WINDOWS))?.name ?? null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [visible, open]);

  if (!open) {
    return (
      <div className="relative -mt-px flex h-full items-center justify-center bg-canvas">
        <EmptyState
          title="没有打开的研讨"
          detail="在侧栏项目的 ⋯ 里点「请几家研讨…」发起一场；进行中和最近几天的研讨挂在侧栏项目下面，更早的在对话管理里。"
          action={
            <button
              type="button"
              onClick={() => openConsult({ projectRoot: null })}
              className="inline-flex h-8 items-center rounded-lg border border-field px-3 text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              请几家研讨…
            </button>
          }
        />
      </div>
    );
  }
  return (
    // 同对话页主区向上盖 1px（挡住顶栏透出的那条窗口黑缝）：两页来回切时内容不上下跳一下
    <div className="relative -mt-px flex h-full min-w-0 flex-col bg-canvas">
      <ConsultView
        inChatPane
        key={`${open.projectRoot}#${open.id}`}
        projectRoot={open.projectRoot}
        id={open.id}
        projectName={projectName}
        onDeleted={() => closeConsult()}
      />
    </div>
  );
}
