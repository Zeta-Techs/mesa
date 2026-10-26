import assert from "node:assert/strict";
import test from "node:test";
import { parseNotebook, stripAnsi } from "../src/notebook.ts";
import { projectFilePreviewKind } from "../src/project-files.ts";

const nb = {
  nbformat: 4,
  metadata: { language_info: { name: "Python" } },
  cells: [
    { cell_type: "markdown", source: ["# 标题\n", "说明"] },
    {
      cell_type: "code",
      execution_count: 3,
      source: "for i in range(2):\n    print(i)",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["0\n"] },
        { output_type: "stream", name: "stdout", text: "1\n" },
        { output_type: "display_data", data: { "image/png": "iVBOR\nw0K", "text/plain": "<Figure>" } },
        { output_type: "execute_result", data: { "text/html": "<table><tr><td>1</td></tr></table>", "text/plain": "df" } },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[0;31mValueError\u001b[0m: bad"] },
      ],
    },
    { cell_type: "code", execution_count: null, source: "", outputs: [] },
  ],
};

test("笔记本：单元、合并相邻输出流、图优先于文字、traceback 去颜色码", () => {
  const out = parseNotebook(JSON.stringify(nb));
  assert.equal(out.language, "python");
  assert.equal(out.cells.length, 3);
  assert.equal(out.cells[0]!.type, "markdown");
  assert.equal(out.cells[0]!.source, "# 标题\n说明");
  const code = out.cells[1]!;
  assert.equal(code.execCount, 3);
  assert.deepEqual(code.outputs[0], { kind: "text", text: "0\n1\n", stream: "stdout" });
  assert.deepEqual(code.outputs[1], { kind: "image", src: "data:image/png;base64,iVBORw0K" });
  assert.equal(code.outputs[2]!.kind, "html");
  assert.deepEqual(code.outputs[3], { kind: "error", name: "ValueError", value: "bad", traceback: "ValueError: bad" });
  assert.equal(out.cells[2]!.execCount, null);
});

test("笔记本：svg 输出当图片、坏 JSON 与旧版本给人话", () => {
  const svg = parseNotebook(
    JSON.stringify({ nbformat: 4, cells: [{ cell_type: "code", source: "", outputs: [{ output_type: "display_data", data: { "image/svg+xml": "<svg>中</svg>" } }] }] }),
  );
  const o = svg.cells[0]!.outputs[0]!;
  assert.equal(o.kind, "image");
  assert.match((o as { src: string }).src, /^data:image\/svg\+xml;base64,/);
  assert.throws(() => parseNotebook("{"), /不是有效的 JSON/);
  assert.throws(() => parseNotebook(JSON.stringify({ nbformat: 3 })), /旧版笔记本/);
  assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m"), "ok");
});

test("笔记本与音视频的预览分流", () => {
  assert.equal(projectFilePreviewKind("/p/a.ipynb"), "notebook");
  assert.equal(projectFilePreviewKind("/p/a.MP4"), "video");
  assert.equal(projectFilePreviewKind("/p/a.wav"), "audio");
  assert.equal(projectFilePreviewKind("/p/a.zip"), "text");
});
