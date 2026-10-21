/** 从 `language-ts` 这类 class 抽出围栏语言名。 */
export function languageFromCodeClass(className: string): string {
  const m = /(?:^|\s)language-([\w#+.-]+)/i.exec(className);
  return m?.[1] ?? "";
}

export function isMermaidLanguage(lang: string): boolean {
  return lang.trim().toLowerCase() === "mermaid";
}

/** lucide Copy（12px 线框，与界面其余图标同一套；DOM 直接拼，不经 React） */
const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

/**
 * 给 marked 产出的 `pre > code` 套上头栏（语言名 + 复制）。
 * mermaid 围栏只打标，留给图渲染器。已装饰的跳过。
 */
export function decorateMdCodeBlocks(host: HTMLElement): void {
  const doc = host.ownerDocument;
  for (const code of host.querySelectorAll("pre > code")) {
    const pre = code.parentElement;
    if (!pre || pre.closest("[data-md-code]")) continue;
    const lang = languageFromCodeClass(code.className);
    if (isMermaidLanguage(lang)) {
      pre.setAttribute("data-md-mermaid", "1");
      continue;
    }
    const wrap = doc.createElement("div");
    wrap.setAttribute("data-md-code", "1");
    wrap.className = "md-code";
    const bar = doc.createElement("div");
    bar.className = "md-code-bar";
    const label = doc.createElement("span");
    label.className = "md-code-lang";
    label.textContent = lang || "code";
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "md-code-copy";
    btn.innerHTML = `${COPY_ICON}<span class="md-code-copy-label">复制</span>`;
    bar.append(label, btn);
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.append(bar, pre);
  }
}

/** 复制按钮点击：写入剪贴板并短暂改成「已复制」。 */
export function handleMdCodeCopyClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const btn = target.closest(".md-code-copy");
  if (!(btn instanceof HTMLButtonElement)) return false;
  const wrap = btn.closest("[data-md-code]");
  const code = wrap?.querySelector("pre > code");
  const text = code?.textContent ?? "";
  const label = btn.querySelector(".md-code-copy-label") ?? btn;
  void navigator.clipboard.writeText(text).then(() => {
    label.textContent = "已复制";
    window.setTimeout(() => {
      if (label.textContent === "已复制") label.textContent = "复制";
    }, 1200);
  }).catch(() => {});
  return true;
}

/** 数字单元格：整数、小数、百分比、正负号、千分位、科学计数、± 误差、「< 0.05」这类（单位留给表头） */
const NUMERIC_CELL = /^[<>≤≥~≈]?\s*[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s*%?(?:\s*[±]\s*\d+(?:\.\d+)?%?)?$/;

export function isNumericCell(text: string): boolean {
  const t = text.trim();
  return t !== "" && /\d/.test(t) && NUMERIC_CELL.test(t);
}

/**
 * 聊天里的表格：外面套一层可横滚的壳（列多不撑出对话栏）；某一列除表头外全是数字（空格不算）就给这一列
 * 打 md-num（右对齐、等宽数字）。已包过的跳过。笔记阅读不用——那边的双击定位按 table 节点配对
 */
export function decorateMdTables(host: HTMLElement): void {
  const doc = host.ownerDocument;
  for (const table of host.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("md-table-wrap")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "md-table-wrap";
    table.parentNode?.insertBefore(wrap, table);
    wrap.append(table);
    const rows = Array.from(table.querySelectorAll("tr"));
    const body = rows.filter((r) => r.querySelector("td"));
    if (body.length === 0) continue;
    const cols = Math.max(...rows.map((r) => r.children.length));
    for (let c = 0; c < cols; c++) {
      const cells = body.map((r) => r.children[c]).filter((cell): cell is Element => Boolean(cell));
      const filled = cells.filter((cell) => (cell.textContent ?? "").trim() !== "");
      if (filled.length === 0 || !filled.every((cell) => isNumericCell(cell.textContent ?? ""))) continue;
      for (const r of rows) r.children[c]?.classList.add("md-num");
    }
  }
}
