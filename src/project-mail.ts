/** 项目内传话（2026-11-03 项目内协作二期，project_mail.rs）前端纯逻辑：工作台那一行的摘要与每条的状态字（含人在任务面板里留的话） */
import type { ProjectMailDto } from "./types.ts";

export function mailStatusText(m: Pick<ProjectMailDto, "status" | "toOpen">): string {
  if (m.status === "delivered") return "已送到";
  if (m.status === "withdrawn") return "已撤回";
  return m.toOpen ? "等对方空闲" : "对方已结束，送不到";
}

export function mailSummary(mails: readonly Pick<ProjectMailDto, "status" | "toOpen">[]): string {
  const waiting = mails.filter((m) => m.status === "pending" && m.toOpen).length;
  return waiting > 0 ? `留话 ${mails.length} 条，${waiting} 条等对方空闲` : `留话 ${mails.length} 条`;
}
