/**
 * 「AI 写好清单 → 人在里面填 → 交回 AI」这一类人工事项（2026-10-24 用户：定稿步这几件怎么引导用户操作）。
 *
 * 原先这类事项落在「其余带落点的事项」里，行上给的是「提交产物」（选文件上传）和「已见到 1 个文件」，
 * 可清单是 AI 自己写的，人要做的是打开、改状态 / 填空，再让 AI 接着做——两个入口都不对。
 * 这里按标题认出它们，给「打开」和「交给 AI」两个动作；交给 AI 走原对话（同「让 Agent 按决定继续」）。
 */

export interface HandbackTask {
  /** 行上打开文件的按钮 */
  open: string;
  /** 填完交回 AI 的按钮 */
  handback: string;
  /** 交回时发给这一步原对话的话 */
  prompt: (target: string) => string;
}

const FIGURE_PERMISSIONS: HandbackTask = {
  open: "打开清单",
  handback: "清单改好了，交给 AI",
  prompt: (target) =>
    `${target} 的状态我改过了，papers/figure-originals/ 里可能放了出版社原图。` +
    "按清单逐块处理：放了原图的块，按 figures/sources.md 记的同一块从原图重裁（--pdf 给原图文件）、重拼；" +
    "图注出处照清单「图注出处」一列写，已获许可的按回执要求的写法改；状态还是待申请的不动图注。" +
    "改完重渲 PDF、Word 和两份域稿，figures/sources.md 与清单一起提交，告诉我还剩几块待申请。",
};

const DECLARATIONS: HandbackTask = {
  open: "打开填写",
  handback: "填好了，交给 AI",
  prompt: (target) =>
    `${target} 我填好了。把 Authors 一节的作者、单位、通讯作者邮箱写进定稿 YAML 的 author（不要再留「待补」），` +
    "其余各节按我写的原文并进稿件文末 Declarations 一节，不改写；仍写着「待填」的节不进稿件，在报告里列出来。" +
    "AI 使用声明以我核对后的文字为准。改完重渲 PDF、Word 和两份域稿，连同这份文件一起提交。",
};

export function handbackTask(title: string): HandbackTask | null {
  if (title.includes("转载许可")) return FIGURE_PERMISSIONS;
  if (title.includes("投稿声明")) return DECLARATIONS;
  return null;
}
