/** 项目内传话（2026-11-03 项目内协作二期，project_mail.rs）前端纯逻辑：工作台那一行的摘要与每条的状态字（含人在任务面板里留的话） */
import type { ProjectMailDto } from "./types.ts";

/** 两段工作你没插手时最多连续自动送几条（与后端 project_mail.rs RELAY_CAP 镜像） */
export const MAIL_RELAY_CAP = 4;

export function mailStatusText(m: Pick<ProjectMailDto, "status" | "toOpen" | "held">): string {
  if (m.status === "delivered") return "已送到";
  if (m.status === "withdrawn") return "已撤回";
  if (m.held) return `它们已经来回了 ${MAIL_RELAY_CAP} 次，等你看一眼`;
  return m.toOpen ? "等对方空闲" : "对方已结束，送不到";
}

export function mailSummary(mails: readonly Pick<ProjectMailDto, "status" | "toOpen" | "held">[]): string {
  if (mails.some((m) => m.status === "pending" && m.held)) {
    return `留话 ${mails.length} 条，有两段工作来回了 ${MAIL_RELAY_CAP} 次，停下等你看一眼`;
  }
  const waiting = mails.filter((m) => m.status === "pending" && m.toOpen).length;
  return waiting > 0 ? `留话 ${mails.length} 条，${waiting} 条等对方空闲` : `留话 ${mails.length} 条`;
}
