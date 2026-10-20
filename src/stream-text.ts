/**
 * 流式命令输出的终端语义（镜像 updater.rs collapse_cr）：每行只留最后一个 \r 之后的内容，
 * 行尾 \r 属于 \r\n、不算重绘。后端事件保留 \r 原样推来，前端存原文、显示前对全文展开——
 * 进度条常把 \r 放在下一块开头，逐块展开会一帧帧堆成一大片（winget 实证）。
 */
export function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/\r+$/, "");
      const idx = trimmed.lastIndexOf("\r");
      return idx < 0 ? trimmed : trimmed.slice(idx + 1);
    })
    .join("\n");
}
