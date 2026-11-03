import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inlineActionClass } from "./PageFrame";
import { mailStatusText, mailSummary } from "../project-mail";
import { toast } from "../toast";
import type { ProjectMailDto } from "../types";

/**
 * 工作台项目分组里的「留话」（2026-11-03 项目内协作二期）：一段工作给另一段的、你在任务面板里留的都列在这，看得见、没送的能撤回。
 * 7 天内一条都没有就不画；送达由终端页在收话方空闲时经它自己的发送链完成（TerminalPage）
 */
export default function ProjectMailRow({ projectPath }: { projectPath: string }) {
  const [mails, setMails] = useState<ProjectMailDto[]>([]);
  const [open, setOpen] = useState(false);

  async function load() {
    setMails(await invoke<ProjectMailDto[]>("mail_list", { projectRoot: projectPath }).catch(() => [] as ProjectMailDto[]));
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  if (mails.length === 0) return null;
  return (
    <div className="pb-2 pl-[calc(1.5rem+6px+0.75rem)] pr-4 text-xs">
      <button type="button" className="text-l3 hover:text-l1" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="text-xs">{mailSummary(mails)}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {mails.map((m) => (
            <li key={m.id} className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-l2" title={m.text}>
                <span className="text-l3">
                  {m.fromLabel} → {m.toLabel} · {mailStatusText(m)}：
                </span>
                {m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text}
              </span>
              {m.status === "pending" && (
                <button
                  type="button"
                  className={inlineActionClass}
                  onClick={async () => {
                    try {
                      await invoke("mail_withdraw", { id: m.id });
                      await load();
                    } catch (reason) {
                      toast(String(reason), "error");
                    }
                  }}
                >
                  <span className="text-xs">撤回</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
