import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ConsultStartDialog from "./ConsultStartDialog";
import { useAppStore } from "../store";
import { toast } from "../toast";
import type { ConsultMaterial } from "../consult";

type Initial = {
  projectRoot?: string | null;
  question?: string;
  materials?: ConsultMaterial[];
  readRoot?: string;
  readLabel?: string;
};

/**
 * 研讨发起弹层的唯一挂载处（2026-11-11 用户：从步骤卡、人工请求、评审页点进来别跳页）：仿 ProjectAssistantHost 挂在 App，
 * 消费 store.consultReq 原地打开；对话管理栏头的「研讨」也走这里。开始后不跳页，提示一句、点「去看看」才打开研讨页（侧栏这个项目下也多一行）
 */
export default function ConsultHost() {
  const req = useAppStore((s) => s.consultReq);
  const clearReq = useAppStore((s) => s.clearConsultReq);
  const showConsult = useAppStore((s) => s.showConsult);
  const [initial, setInitial] = useState<Initial | null>(null);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);

  useEffect(() => {
    if (!req) return;
    const next: Initial = {
      projectRoot: req.projectRoot,
      question: req.question,
      materials: req.materials,
      readRoot: req.readRoot,
      readLabel: req.readLabel,
    };
    clearReq();
    void invoke<{ path: string; name: string }[]>("list_projects")
      .then((list) => setProjects(list.map((p) => ({ path: p.path, name: p.name }))))
      .catch(() => setProjects([]))
      .finally(() => setInitial(next));
  }, [req, clearReq]);

  return (
    <ConsultStartDialog
      open={initial !== null}
      onClose={() => setInitial(null)}
      projects={projects}
      initial={initial}
      onCreated={(projectRoot, id, members) => {
        setInitial(null);
        toast(`研讨开始了，${members} 家在答`, "success", {
          actions: [{ label: "去看看", primary: true, onClick: () => showConsult(projectRoot, id) }],
        });
      }}
    />
  );
}
