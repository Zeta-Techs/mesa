/**
 * 认得出的 CLI 中途通知（2026-11-06 用户：「不懂的用户弹出这个可能不知道怎么解决」）。
 * Claude Code 经第三方网关、开着「帮我批准」（auto mode）时，一天弹一次「auto mode 分类器计费」说明，
 * 按回车前这一轮停着。原文是一大段英文，提到网关、分类器，看不懂的人不敢点或没看见，AI 就一直停着。
 * 这里认出这一条，聊天层换成中文说明卡；人可以勾「以后自动略过」，之后由 Mesa 替他按回车。
 * 只认这一条：照它原话，回车只是「看过了」，不改任何设置；别的通知照旧等人点。
 */

/** 认这条通知的固定句子（Claude Code 2.1.x 原文，见 CLI 里 xYt 的 title） */
const CLASSIFIER_TITLE = /auto mode to no longer charge for classifier requests/i;
const GATEWAY_HOST = /requests go through\s+(.+?),\s*which isn't compatible/i;

/** 通知正文（tui-panel.ts parseTuiNotice 的行）是不是那条计费说明；是就取出网关名（可能没有） */
export function classifierBillingNotice(lines: readonly string[] | null | undefined): { gateway: string | null } | null {
  if (!lines?.length) return null;
  // 终端里按宽度折行：拼成一段再认
  const text = lines.map((l) => l.trim()).join(" ").replace(/\s+/g, " ");
  if (!CLASSIFIER_TITLE.test(text)) return null;
  const gateway = GATEWAY_HOST.exec(text)?.[1]?.trim() || null;
  return { gateway };
}

/** 中文说明（卡片正文） */
export function classifierNoticeText(gateway: string | null): string {
  return (
    `Claude Code 改了「帮我批准」的计费：直连官方的会话，以后判断要不要放行这一下不再单独收费。` +
    `你这个会话走的是${gateway ? ` ${gateway}` : "第三方网关"}，用不上新办法，照旧计费——自动批准照常工作，什么都不会坏。\n` +
    `点继续就行，不改任何设置。Claude Code 每天最多弹一次；不想再停在这里，可以点「以后自动略过」。`
  );
}

const SKIP_KEY = "ccode.autoSkipClassifierNotice";

/** 用户勾过「以后自动略过」（只在这台电脑上记；设置页「聊天」里能关） */
export function classifierNoticeAutoSkip(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

export function setClassifierNoticeAutoSkip(on: boolean) {
  try {
    if (on) localStorage.setItem(SKIP_KEY, "1");
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    /* 存不下只是下次还会出卡 */
  }
}
