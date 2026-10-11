/** 终端粘贴防线（借鉴 Tabby 的 paste 保护，按 Mesa 场景收敛）：
 *  - 换行统一为 \r（终端行约定）；
 *  - 普通缓冲里剪掉收尾回车——「粘贴即执行」的最常见事故；
 *  - shell 标签的多行粘贴先经人确认；agent 标签不拦（Ink/TUI 自己消化，
 *    且 Mesa 的聊天纪律本就「正文与回车分写」）；
 *  - 备用屏（全屏 TUI）由程序自己消化粘贴，不修不拦。 */

export interface PasteGuardInput {
  text: string;
  /** agent 标签 = Mesa 拉起的 CLI；shell 标签 = 回落 shell / 手动打开的 shell */
  kind: "agent" | "shell";
  alternateScreen: boolean;
}

export type PasteGuardPlan =
  | { action: "write"; data: string; note?: string }
  | {
      action: "confirm";
      data: string;
      lines: number;
      preview: string;
      /** 收尾/开头换行已被剪掉（确认框文案据此措辞，不硬承诺） */
      trimmed: boolean;
    };

export function pasteGuardPlan(input: PasteGuardInput): PasteGuardPlan {
  let text = input.text.replace(/\r?\n/g, "\r");
  if (input.alternateScreen) {
    return { action: "write", data: text };
  }
  // 普通缓冲：只剪收尾/开头的**换行**——它才是「粘贴即执行」的来源；
  // 空格与制表符不动（粘贴缩进代码不能丢缩进，与 Tabby 的全空白 trim 不同）
  const trimmed = text.replace(/^\r+/, "").replace(/\r+$/, "");
  const didTrim = trimmed !== text;
  text = trimmed;
  if (!text) {
    return { action: "write", data: "", note: didTrim ? "粘贴内容只有换行" : undefined };
  }
  const lines = text.split("\r").filter((line) => line.trim()).length;
  if (lines > 1 && input.kind === "shell") {
    return {
      action: "confirm",
      data: text,
      lines,
      preview: text.split("\r").slice(0, 8).join("\n").slice(0, 600),
      trimmed: didTrim,
    };
  }
  return {
    action: "write",
    data: text,
    note: didTrim ? "已去掉首尾换行" : undefined,
  };
}
