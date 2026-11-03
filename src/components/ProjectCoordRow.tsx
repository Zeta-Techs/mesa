import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { beginAskAi } from "./AskAiModal";
import SplitPlanDialog from "./SplitPlanDialog";
import { buildCoordinatorPrompt, parseSplitPlan } from "../split-plan";
import { IS_WINDOWS } from "../hotkeys";

/**
 * 工作台项目分组下的协调对话一行（2026-11-03 项目内协作三期）：「协调对话」开 / 回到这个项目唯一的协调对话（reuseKey coord:<项目>），
 * 它不自己干活，看一眼答进展、转告、按格式起草拆分方案；方案写好这一行多一个「拆分方案待你批准（N 路）」，点开批准才一起开工
 */
export default function ProjectCoordRow({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    const got = await invoke<{ text: string } | null>("split_plan_read", { projectRoot: projectPath }).catch(() => null);
    setPlan(got?.text ?? null);
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const lanes = plan ? parseSplitPlan(plan).lanes.length : 0;
  return (
    <div className="flex flex-wrap items-center gap-3 pb-1 pl-[calc(1.5rem+6px+0.75rem)] pr-4 text-xs">
      <button
        type="button"
        className="text-l3 hover:text-l1"
        title="这个项目的协调对话：问进展、让它转告某一段工作、让它起草把一件事拆成几路的方案（你批准才开）"
        onClick={() =>
          beginAskAi({
            path: "",
            name: projectName,
            cwd: projectPath,
            root: projectPath,
            reuseKey: `coord:${projectPath}`,
            prompt: buildCoordinatorPrompt(projectName, IS_WINDOWS),
            preview: false,
          })
        }
      >
        <span className="text-xs">协调对话</span>
      </button>
      {plan && (
        <button type="button" className="text-warn-text hover:underline" onClick={() => setOpen(true)}>
          <span className="text-xs">拆分方案待你批准（{lanes} 路）</span>
        </button>
      )}
      {open && plan && (
        <SplitPlanDialog
          projectPath={projectPath}
          text={plan}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
