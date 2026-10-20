import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff, parsePatch, resultStatus, splitPath, toolActivities } from "../src/tool-activity.ts";

const CWD = "/Users/me/proj";
const one = (name: string | null, input: unknown) => {
  const list = toolActivities(name, typeof input === "string" ? input : JSON.stringify(input), CWD);
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};

test("编辑：文件名 + 工作目录内的相对目录 + 增删行数（只算真正改了的行）", () => {
  const a = one("Edit", {
    file_path: "/Users/me/proj/src/components/LitWatchCard.tsx",
    old_string: "a\nb\nc\nd",
    new_string: "a\nB\nc\nD",
  });
  assert.equal(a.kind, "edit");
  assert.equal(a.verb, "编辑");
  assert.equal(a.target, "LitWatchCard.tsx");
  assert.equal(a.dir, "src/components/");
  assert.equal(a.added, 2);
  assert.equal(a.removed, 2);
  assert.deepEqual(
    a.diff?.map((l) => l.op).join(""),
    " -+ -+",
    "中间那行没改，留作上下文",
  );
  // Claude MultiEdit / OpenCode edit / Kimi StrReplaceFile：各家键名不同
  assert.equal(one("MultiEdit", { file_path: "/x/a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4\n5" }] }).added, 3);
  assert.equal(one("edit", { filePath: "/Users/me/proj/a.ts", oldString: "x", newString: "y" }).removed, 1);
  const k = one("StrReplaceFile", { path: "/Users/me/proj/b.py", edit: { old: "p", new: "q" } });
  assert.equal(k.kind, "edit");
  assert.equal(k.target, "b.py");
  assert.equal(k.dir, "");
});

test("写入：行数记作新增；工作目录外的家目录路径折成 ~", () => {
  const a = one("Write", { file_path: "/Users/me/Desktop/测试.txt", content: "测试\n" });
  assert.equal(a.kind, "write");
  assert.equal(a.target, "测试.txt");
  assert.equal(a.dir, "~/Desktop/");
  assert.equal(a.added, 1);
  assert.equal(a.removed, null);
  assert.deepEqual(splitPath("C:\\Users\\me\\x\\y.md", null), { name: "y.md", dir: "~/x/" });
});

test("运行：有说明就先说说明，命令放旁边；Codex 的 bash -lc 数组只取命令", () => {
  const a = one("Bash", { command: "npm test 2>&1 | tail -5", description: "跑前端测试" });
  assert.equal(a.kind, "run");
  assert.equal(a.target, "跑前端测试");
  assert.equal(a.note, "npm test 2>&1 | tail -5");
  assert.equal(a.command, "npm test 2>&1 | tail -5");
  const c = one("shell", { command: ["bash", "-lc", "cargo test"], workdir: "/x" });
  assert.equal(c.target, "cargo test");
  assert.equal(c.note, null);
  assert.equal(one("exec_command", { cmd: "cat a.md" }).target, "cat a.md");
});

test("Codex 脚本模式：从 tools.exec_command({cmd}) 里取出命令", () => {
  const script =
    'const r = await tools.exec_command({cmd:"sed -n \'1,20p\' \\"a b.md\\" && ls","workdir":"/w"});\ntext(r.output);\n' +
    'await tools.exec_command({cmd:"git status"});';
  const a = one("exec", script);
  assert.equal(a.kind, "run");
  assert.equal(a.target, "sed -n '1,20p' \"a b.md\" && ls");
  assert.equal(a.note, "还有 1 条");
  assert.equal(one("exec", "text('hi')").target, "运行脚本");
});

test("补丁：一次改多个文件拆成多行，新建 / 删除分开说", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@ fn a",
    " keep",
    "-old",
    "+new",
    "+more",
    "*** Add File: docs/b.md",
    "+# 标题",
    "+正文",
    "*** Delete File: tmp/c.txt",
    "*** End Patch",
  ].join("\n");
  const list = toolActivities("apply_patch", patch, CWD);
  assert.deepEqual(
    list.map((a) => [a.verb, a.target, a.dir, a.added, a.removed]),
    [
      ["编辑", "a.ts", "src/", 2, 1],
      ["新建", "b.md", "docs/", 2, 0],
      ["删除", "c.txt", "tmp/", null, null],
    ],
  );
  assert.equal(parsePatch(patch.replace(/\n/g, "\\n")).length, 3, "脚本里转义过的补丁也认");
});

test("搜索 / 读取 / 网页 / MCP / 认不出的工具", () => {
  const g = one("Grep", { pattern: "connIssue", path: "/Users/me/proj/src" });
  assert.deepEqual([g.kind, g.target, g.note], ["search", "connIssue", "src"]);
  const r = one("read_file", { absolute_path: "/Users/me/proj/README.md" });
  assert.deepEqual([r.kind, r.target, r.dir], ["read", "README.md", ""]);
  const w = one("WebFetch", { url: "https://docs.example.com/a/b", prompt: "x" });
  assert.deepEqual([w.verb, w.target], ["打开网页", "docs.example.com"]);
  assert.deepEqual([one("WebSearch", { query: "GLM 限额" }).verb, one("WebSearch", { query: "GLM 限额" }).target], ["搜索网页", "GLM 限额"]);
  const m = one("mcp__consensus__search", { query: "x" });
  assert.deepEqual([m.kind, m.target, m.note], ["mcp", "search", "consensus"]);
  const o = one("FancyTool", { foo: 1 });
  assert.deepEqual([o.kind, o.verb, o.target], ["other", "调用", "FancyTool"]);
  assert.equal(one("TodoWrite", { todos: [{}, {}, {}] }).target, "3 项");
});

test("结果状态只看开头：报错 / 非零退出 / 被拒绝 / 中断；文件正文里碰巧有 Error 不算", () => {
  assert.equal(resultStatus("<tool_use_error>File has not been read yet</tool_use_error>"), "failed");
  assert.equal(resultStatus("Exit code 1\nnpm ERR! missing script"), "failed");
  assert.equal(resultStatus("Chunk ID: 1\nProcess exited with code 2\nOutput:"), "failed");
  assert.equal(
    resultStatus("The user doesn't want to proceed with this tool use. The tool use was rejected"),
    "denied",
  );
  assert.equal(resultStatus("[Request interrupted by user for tool use]"), "interrupted");
  assert.equal(resultStatus("     1\timport x\n     2\tthrow new Error: boom"), "ok");
  assert.equal(resultStatus("Process exited with code 0\nok"), "ok");
  assert.equal(resultStatus(null), "ok");
});

test("行级差异：首尾相同的行收成上下文，远处折成 ⋯", () => {
  const before = ["1", "2", "3", "4", "5", "6"].join("\n");
  const after = ["1", "2", "3", "4x", "5", "6"].join("\n");
  const d = lineDiff(before, after);
  assert.deepEqual(
    d.map((l) => `${l.op}${l.text}`),
    ["~", " 2", " 3", "-4", "+4x", " 5", " 6"],
  );
  assert.deepEqual(lineDiff("", "a\nb").map((l) => l.op), ["+", "+"]);
});

test("splitPath：Windows 下工作目录内判定跨大小写/分隔符/verbatim（isWindows 显式传入）", () => {
  const cwd = String.raw`C:\Users\Me\Proj`;
  assert.deepEqual(splitPath(String.raw`c:\users\me\proj\src\a.ts`, cwd, true), { name: "a.ts", dir: "src/" });
  assert.deepEqual(splitPath(String.raw`\\?\C:\Users\Me\Proj\b.md`, cwd, true), { name: "b.md", dir: "" });
  // 段边界：Proj2 不在 Proj 内
  assert.deepEqual(splitPath(String.raw`C:\Users\Me\Proj2\c.md`, cwd, true), { name: "c.md", dir: "~/Proj2/" });
  // 缺省大小写敏感（旧口径）：大小写不同不算工作目录内
  assert.equal(splitPath("c:/users/me/proj/a.ts", cwd).dir, "c:/users/me/proj/");
  const list = toolActivities("Read", JSON.stringify({ file_path: String.raw`c:\users\me\proj\src\a.ts` }), cwd, true);
  assert.equal(list[0].dir, "src/");
});
