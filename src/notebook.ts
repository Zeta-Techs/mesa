/**
 * Jupyter 笔记本（.ipynb）解析成可显示的单元（2026-10-26：原先只能当一大段 JSON 看，带输出的还常超 256 KB 被截断）。
 * 只解析 nbformat 4（Jupyter 默认）；3 及更老的提示用系统应用打开。纯逻辑（tests/notebook.test.ts）。
 */

export type NbOutput =
  | { kind: "text"; text: string; stream: "stdout" | "stderr" | "result" }
  | { kind: "image"; src: string }
  | { kind: "html"; html: string }
  | { kind: "markdown"; md: string }
  | { kind: "error"; name: string; value: string; traceback: string };

export interface NbCell {
  type: "markdown" | "code" | "raw";
  source: string;
  execCount: number | null;
  outputs: NbOutput[];
}

export interface Notebook {
  language: string;
  cells: NbCell[];
}

function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.map((s) => (typeof s === "string" ? s : "")).join("");
  return typeof src === "string" ? src : "";
}

/** 终端颜色控制符（traceback 里满是 \x1b[0;31m 这类） */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function richOutput(data: Record<string, unknown>): NbOutput | null {
  for (const mime of IMAGE_MIMES) {
    const v = joinSource(data[mime]).replace(/\s+/g, "");
    if (v) return { kind: "image", src: `data:${mime};base64,${v}` };
  }
  const svg = joinSource(data["image/svg+xml"]);
  if (svg) {
    // svg 当图片显示（img 不执行脚本），不直接插 DOM
    let bin = "";
    for (const b of new TextEncoder().encode(svg)) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    return { kind: "image", src: `data:image/svg+xml;base64,${b64}` };
  }
  const html = joinSource(data["text/html"]);
  if (html) return { kind: "html", html };
  const md = joinSource(data["text/markdown"]);
  if (md) return { kind: "markdown", md };
  const latex = joinSource(data["text/latex"]);
  if (latex) return { kind: "markdown", md: latex };
  const plain = joinSource(data["text/plain"]);
  if (plain) return { kind: "text", text: plain, stream: "result" };
  return null;
}

export function parseNotebook(json: string): Notebook {
  let nb: Record<string, unknown>;
  try {
    nb = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("这份笔记本不是有效的 JSON（可能还没写完，或被截断了）");
  }
  if (typeof nb.nbformat === "number" && nb.nbformat < 4) {
    throw new Error(`这是旧版笔记本（nbformat ${nb.nbformat}），请用 Jupyter 打开另存一次`);
  }
  const meta = (nb.metadata ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const language =
    String(meta.language_info?.name ?? meta.kernelspec?.language ?? "python").toLowerCase();
  const cells: NbCell[] = [];
  for (const raw of Array.isArray(nb.cells) ? nb.cells : []) {
    const c = raw as Record<string, unknown>;
    const type = c.cell_type === "markdown" || c.cell_type === "raw" ? c.cell_type : "code";
    const outputs: NbOutput[] = [];
    for (const o of Array.isArray(c.outputs) ? c.outputs : []) {
      const out = o as Record<string, unknown>;
      if (out.output_type === "stream") {
        outputs.push({
          kind: "text",
          text: stripAnsi(joinSource(out.text)),
          stream: out.name === "stderr" ? "stderr" : "stdout",
        });
      } else if (out.output_type === "error") {
        outputs.push({
          kind: "error",
          name: String(out.ename ?? "Error"),
          value: String(out.evalue ?? ""),
          traceback: stripAnsi(
            (Array.isArray(out.traceback) ? out.traceback : []).map(String).join("\n"),
          ),
        });
      } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
        const rich = richOutput((out.data ?? {}) as Record<string, unknown>);
        if (rich) outputs.push(rich);
      }
    }
    // 相邻的同一路输出流合成一段（print 循环会产出几十条）
    const merged: NbOutput[] = [];
    for (const o of outputs) {
      const last = merged[merged.length - 1];
      if (o.kind === "text" && last?.kind === "text" && last.stream === o.stream) {
        last.text += o.text;
      } else merged.push(o);
    }
    cells.push({
      type,
      source: joinSource(c.source),
      execCount: typeof c.execution_count === "number" ? c.execution_count : null,
      outputs: merged,
    });
  }
  return { language, cells };
}
