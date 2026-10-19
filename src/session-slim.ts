/**
 * 会话瘦身（撞网关「请求体过大 413」）的纯逻辑：提示条与确认弹层怎么对人说、什么时候不能动手。
 * 数字与 level 由后端 session_slim.rs 估算给出，这里只管措辞与拦路条件，不读文件系统、不读平台。
 */
import type { SlimApplyDto, SlimInspectDto } from "./types.ts";

export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export interface SlimNotice {
  tone: "warn" | "err";
  title: string;
  detail: string;
}

/** 提示条：只在请求体逼近/超过网关上限、且确实有较早的截图可移除时出现 */
export function slimNotice(i: SlimInspectDto | null): SlimNotice | null {
  if (!i || !i.supported || !i.scanned || i.removable <= 0) return null;
  const size = `下一次发送约 ${formatMB(i.bodyBytes)}，其中 ${i.mediaCount} 张截图占 ${formatMB(i.mediaBytes)}`;
  if (i.level === "danger") {
    return {
      tone: "err",
      title: "这段对话的请求体已经过大",
      detail: `${size}，已超过或贴近网关单次请求的上限，继续发送会报 413 “Request body too large”。`,
    };
  }
  if (i.level === "warn") {
    return {
      tone: "warn",
      title: "这段对话的请求体越来越大",
      detail: `${size}。再积累下去可能撞上网关的请求体上限（413）。`,
    };
  }
  return null;
}

/** 「瘦身…」菜单项：扫描过且有较早的截图可移除就给，不必等到告警线，方便提前处理 */
export function slimMenuAvailable(i: SlimInspectDto | null): boolean {
  return !!i && i.supported && i.scanned && i.removable > 0;
}

/** 动手前的拦路原因；null = 可以动手 */
export function slimBlockReason(
  i: SlimInspectDto,
  runningInMesaTab: boolean,
): string | null {
  if (runningInMesaTab) {
    return "这条对话正在 Mesa 的终端标签里运行。先关掉那个标签，再来瘦身。";
  }
  if (i.recentlyWritten) {
    return "这条对话最近一分钟内还有写入，多半有进程正在使用它（Claude 客户端或别的终端）。先在那边停止并退出这条对话，再来瘦身。";
  }
  return null;
}

/** 弹层里「瘦身后约多大」：按平均每张截图的大小估，只用于事前预告 */
export function estimateBodyAfter(i: SlimInspectDto): number {
  if (i.mediaCount <= 0) return i.bodyBytes;
  const removedBytes = Math.round((i.mediaBytes * i.removable) / i.mediaCount);
  return Math.max(0, i.bodyBytes - removedBytes);
}

export function slimResultText(r: SlimApplyDto): string {
  return `已移除 ${r.removed} 张较早的截图，保留最近 ${r.kept} 张。请求体约 ${formatMB(r.bodyBefore)} → ${formatMB(r.bodyAfter)}，会话文件 ${formatMB(r.bytesBefore)} → ${formatMB(r.bytesAfter)}。`;
}
