import assert from "node:assert/strict";
import test from "node:test";
import {
  absUnderRoot,
  blockerList,
  blockerText,
  buildChangeTree,
  fileDiffCacheKey,
  foldContextRows,
  parseDiff,
  parseHunkStart,
  reviewFileChip,
  type DiffLine,
} from "../src/diff-view.ts";
import type { GitFileDto, WorkspaceHealthDto } from "../src/types.ts";

/**
 * 评审页 diff 纯逻辑。
 *
 * 这些函数原先关在 WorkspaceReviewView.tsx 里，没有任何测试——而它们恰好是
 * 「改错了界面上只是看着有点怪」的一类：行号算错、折叠吞掉改动、拦截项顺序反了，
 * 点界面很难发现。搬出来就钉住。
 */

function file(path: string, status = "M"): GitFileDto {
  return { path, status, additions: 1, deletions: 0 };
}

/** 只给关心字段的健康检查对象（其余按后端缺省） */
function health(over: Partial<WorkspaceHealthDto>): WorkspaceHealthDto {
  return {
    conflict: false,
    mainDirty: false,
    mainOffBase: false,
    gitdirDetached: false,
    ledgerPending: false,
    worktreeHead: "abc",
    ...over,
  } as WorkspaceHealthDto;
}

test("hunk 头解析：长度可省，缺 @@ 不算", () => {
  assert.deepEqual(parseHunkStart("@@ -1,6 +1,7 @@"), { oldStart: 1, newStart: 1 });
  assert.deepEqual(parseHunkStart("@@ -12 +34 @@ fn main()"), { oldStart: 12, newStart: 34 });
  assert.deepEqual(parseHunkStart("@@ -100,0 +200,3 @@"), { oldStart: 100, newStart: 200 });
  assert.equal(parseHunkStart("@@ -1,6 +1,7"), null, "缺尾部 @@ 不认");
  assert.equal(parseHunkStart("+ @@ -1 +1 @@"), null, "行首不是 hunk 头");
  assert.equal(parseHunkStart("some text"), null);
});

test("解析：纯上下文行两侧行号同步前进", () => {
  const rows = parseDiff("@@ -10,3 +20,3 @@\n a\n b\n c\n");
  const ctx = rows.filter((r) => r.kind === "line");
  assert.equal(ctx.length, 3);
  assert.deepEqual(
    ctx.map((r) => [r.oldNo, r.newNo]),
    [[10, 20], [11, 21], [12, 22]],
  );
  for (const r of ctx) {
    assert.equal(r.oldKind, "context");
    assert.equal(r.newKind, "context");
  }
});

test("解析：hunk 头自成一类行，两侧都无行号", () => {
  const rows = parseDiff("@@ -1 +1 @@\n a\n");
  assert.equal(rows[0].kind, "hunk");
  assert.equal(rows[0].header, "@@ -1 +1 @@");
  assert.equal(rows[0].oldNo, null);
  assert.equal(rows[0].newNo, null);
});

/** 只看改动行（hunk 头自成一类行，不算内容）。 */
function contentRows(text: string): DiffLine[] {
  return parseDiff(text).filter((r) => r.kind === "line");
}

test("解析：等长删增配成对，两侧行号各自连续", () => {
  const rows = contentRows("@@ -5,2 +5,2 @@\n-old one\n+new one\n");
  assert.equal(rows.length, 1, "一条删一条增配成同一行，不是两行");
  assert.equal(rows[0].oldNo, 5);
  assert.equal(rows[0].newNo, 5);
  assert.equal(rows[0].oldKind, "delete");
  assert.equal(rows[0].newKind, "add");
  assert.equal(rows[0].oldText, "old one");
  assert.equal(rows[0].newText, "new one");
});

test("解析：删多于增时，短的那侧补 blank 且不推进行号", () => {
  // 删 3 行、增 1 行：多出来的两行没有新侧对应
  const rows = contentRows("@@ -1,3 +1,1 @@\n-a\n-b\n-c\n+only\n");
  assert.equal(rows.length, 3);
  const blanks = rows.filter((r) => r.newKind === "blank");
  assert.equal(blanks.length, 2, "两行没有新侧对应");
  for (const b of blanks) {
    assert.equal(b.newNo, null, "blank 侧不给行号");
    assert.equal(b.newText, "");
    assert.equal(b.oldKind, "delete");
  }
  assert.deepEqual(
    rows.map((r) => r.oldNo),
    [1, 2, 3],
    "旧侧行号连续",
  );
});

test("解析：增多于删时，旧侧补 blank", () => {
  const rows = contentRows("@@ -7,1 +7,3 @@\n-only\n+add1\n+add2\n+add3\n");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.newNo),
    [7, 8, 9],
  );
  const blanks = rows.filter((r) => r.oldKind === "blank");
  assert.equal(blanks.length, 2);
  for (const b of blanks) {
    assert.equal(b.oldNo, null);
    assert.equal(b.oldText, "");
    assert.equal(b.newKind, "add");
  }
});

test("解析：删增段被上下文打断时各自配对，不跨段配对", () => {
  const rows = contentRows("@@ -1,3 +1,3 @@\n-a\n+b\n same\n-c\n+d\n");
  assert.deepEqual(
    rows.map((r) => [r.oldNo, r.newNo, r.oldText, r.newText]),
    [
      [1, 1, "a", "b"],
      [2, 2, "same", "same"],
      [3, 3, "c", "d"],
    ],
  );
});

test("解析：跳过 diff 元信息行，不把它们当成内容", () => {
  const text = [
    "diff --git a/x.txt b/x.txt",
    "index 111..222 100644",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const rows = parseDiff(text);
  assert.equal(rows.length, 2, "只剩一个 hunk 头被跳过后的一对删增");
  for (const r of rows) {
    assert.ok(!r.oldText.startsWith("diff --git"));
    assert.ok(!r.newText.startsWith("+++"));
    assert.ok(!r.oldText.includes("No newline"));
  }
});

test("解析：空 diff 得到空数组", () => {
  assert.deepEqual(parseDiff(""), []);
});

test("解析：hunk 起点覆盖默认行号", () => {
  // 第二个 hunk 的起点必须按头上写的那行算，不能接着上一个 hunk 累加
  const rows = parseDiff("@@ -1,1 +1,1 @@\n a\n@@ -50,1 +60,1 @@\n b\n");
  const ctx = rows.filter((r) => r.kind === "line");
  assert.deepEqual(
    ctx.map((r) => [r.oldNo, r.newNo]),
    [[1, 1], [50, 60]],
  );
});

test("变更树：目录排在文件前，同级按名排序", () => {
  const tree = buildChangeTree([
    file("src/b.ts"),
    file("README.md"),
    file("src/a.ts"),
    file("docs/x.md"),
  ]);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["docs", "src", "README.md"],
  );
  const src = tree.find((n) => n.name === "src")!;
  assert.deepEqual(
    src.children.map((n) => n.name),
    ["a.ts", "b.ts"],
  );
  assert.equal(tree.find((n) => n.name === "README.md")!.file?.path, "README.md");
  assert.equal(src.file, null, "目录节点自己不挂文件");
});

test("变更树：深层路径逐级建节点，路径字段是前缀", () => {
  const tree = buildChangeTree([file("a/b/c/d.txt")]);
  let node = tree[0];
  const seen: string[] = [];
  while (node) {
    seen.push(`${node.name}=${node.path}`);
    node = node.children[0];
  }
  assert.deepEqual(seen, ["a=a", "b=a/b", "c=a/b/c", "d.txt=a/b/c/d.txt"]);
});

test("变更树：同一目录多个文件共用一个节点，不重复建", () => {
  const tree = buildChangeTree([file("src/a.ts"), file("src/b.ts")]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 2);
});

test("变更树：空输入得到空数组", () => {
  assert.deepEqual(buildChangeTree([]), []);
});

function ctxLine(n: number): DiffLine {
  return {
    kind: "line",
    oldNo: n,
    newNo: n,
    oldText: `line ${n}`,
    newText: `line ${n}`,
    oldKind: "context",
    newKind: "context",
  };
}

function addLine(n: number): DiffLine {
  return {
    kind: "line",
    oldNo: null,
    newNo: n,
    oldText: "",
    newText: `new ${n}`,
    oldKind: "blank",
    newKind: "add",
  };
}

test("折叠：连续上下文不超过阈值就原样保留", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ctxLine(i + 1));
  const out = foldContextRows(rows, new Set());
  assert.equal(out.length, 12);
  assert.ok(out.every((r) => r.kind === "line"), "12 行不该折");
});

test("折叠：超过阈值折中间，只留首尾各 3 行", () => {
  const rows = Array.from({ length: 13 }, (_, i) => ctxLine(i + 1));
  const out = foldContextRows(rows, new Set());
  assert.equal(out.length, 7, "3 + 折叠块 + 3");
  assert.equal(out[0].kind, "line");
  assert.equal(out[3].kind, "fold");
  const fold = out[3] as { kind: "fold"; id: string; rows: DiffLine[] };
  assert.equal(fold.rows.length, 7, "13 - 3 - 3");
  assert.equal(fold.rows[0].oldText, "line 4");
  assert.equal(fold.rows[6].oldText, "line 10");
  assert.equal(out[6].kind, "line");
});

test("折叠：展开集合里的块不折，id 按出现顺序编号", () => {
  const rows = Array.from({ length: 13 }, (_, i) => ctxLine(i + 1));
  const collapsed = foldContextRows(rows, new Set());
  const id = (collapsed[3] as { id: string }).id;
  assert.equal(id, "fold-0");

  const expanded = foldContextRows(rows, new Set([id]));
  assert.equal(expanded.length, 13, "展开后全部是行");
  assert.ok(expanded.every((r) => r.kind === "line"));
});

test("折叠：非上下文行打断连续段，不跨改动折叠", () => {
  // 两段各 8 行上下文，中间隔一行新增：两段都不到阈值，谁都不折
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ctxLine(i + 1)),
    addLine(100),
    ...Array.from({ length: 8 }, (_, i) => ctxLine(i + 20)),
  ];
  const out = foldContextRows(rows, new Set());
  assert.equal(out.length, 17);
  assert.ok(out.every((r) => r.kind === "line"));
});

test("折叠：两段超长上下文各自折，id 递增互不冲突", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ctxLine(i + 1)),
    addLine(50),
    ...Array.from({ length: 20 }, (_, i) => ctxLine(i + 100)),
  ];
  const out = foldContextRows(rows, new Set());
  const folds = out.filter((r) => r.kind === "fold") as { id: string }[];
  assert.equal(folds.length, 2);
  assert.deepEqual(
    folds.map((f) => f.id),
    ["fold-0", "fold-1"],
  );
});

test("折叠：开头与结尾的上下文超长同样折", () => {
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => ctxLine(i + 1)),
    addLine(99),
  ];
  const out = foldContextRows(rows, new Set());
  assert.equal(out[0].kind, "line");
  assert.equal(out[3].kind, "fold");
  assert.equal(out[out.length - 1].kind, "line");
  assert.equal((out[out.length - 1] as DiffLine).newKind, "add");
});

test("折叠：全是上下文时只折一次，不折成两段", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ctxLine(i + 1));
  const out = foldContextRows(rows, new Set());
  assert.equal(out.filter((r) => r.kind === "fold").length, 1);
  assert.equal(out.length, 7);
});

test("拦截项：无健康检查数据时什么都不拦", () => {
  assert.deepEqual(blockerList(null), []);
  assert.deepEqual(blockerText(null), []);
});

test("拦截项：干净的仓库不拦", () => {
  const clean = health({});
  assert.deepEqual(blockerList(clean), []);
  assert.deepEqual(blockerText(clean), []);
});

test("拦截项：冲突三种取值分别对应「有冲突 / 无法预检 / 无冲突」", () => {
  assert.deepEqual(
    blockerList(health({ conflict: true })).map((b) => b.key),
    ["conflict"],
  );
  assert.deepEqual(
    blockerList(health({ conflict: null })).map((b) => b.key),
    ["conflict-unknown"],
  );
  // false = 明确无冲突，不出条目
  assert.deepEqual(blockerList(health({ conflict: false })), []);
});

test("拦截项：顺序是「先拦住你、再提醒你」，主仓脏带 key 供挂快速提交", () => {
  const all = health({
    conflict: true,
    mainDirty: true,
    gitdirDetached: true,
    mainOffBase: true,
  });
  assert.deepEqual(
    blockerList(all).map((b) => b.key),
    ["conflict", "main-dirty", "gitdir", "main-off-base"],
  );
  const dirty = blockerList(all).find((b) => b.key === "main-dirty")!;
  assert.ok(dirty.text.includes("没保存"), "主仓脏要说人话，不是 git 术语");
});

test("拦截项：残留锁最先，没做完的 git 操作排在没保存的改动前，都说人话", () => {
  const all = health({
    staleLock: true,
    conflict: true,
    mainUnfinished: "rebase",
    mainDirty: true,
    mainOffBase: true,
    mainBranch: "side",
  });
  const list = blockerList(all);
  assert.deepEqual(
    list.map((b) => b.key),
    ["stale-lock", "conflict", "main-unfinished", "main-dirty", "main-off-base"],
  );
  assert.ok(list[0].text.includes("锁文件"));
  assert.ok(list[2].text.includes("变基"), list[2].text);
  assert.ok(list[4].text.includes("side"), "说清现在在哪个分支上");
  const detached = blockerList(health({ mainOffBase: true, mainBranch: "HEAD" }));
  assert.equal(detached[0].text, "主文件夹当前不在主分支上");
});

test("拦截项：无法预检冲突与真冲突可以同时出现时不重复", () => {
  // conflict 是 true | false | null，三态互斥，不会同时进两条
  const keys = blockerList(health({ conflict: null })).map((b) => b.key);
  assert.equal(keys.filter((k) => k.startsWith("conflict")).length, 1);
});

test("拦截项文案：与条目一一对应且顺序一致", () => {
  const h = health({ conflict: true, gitdirDetached: true });
  const list = blockerList(h);
  assert.deepEqual(blockerText(h), list.map((b) => b.text));
});

test("路径小工具：root 尾部斜杠归一，rel 前导斜杠吃掉", () => {
  assert.equal(absUnderRoot("/a/b", "c/d"), "/a/b/c/d");
  assert.equal(absUnderRoot("/a/b/", "c/d"), "/a/b/c/d");
  assert.equal(absUnderRoot("/a/b///", "/c/d"), "/a/b/c/d");
  assert.equal(absUnderRoot("C:\\proj", "papers\\x.pdf"), "C:\\proj/papers\\x.pdf");
});

test("缓存键：三者任一不同即换键", () => {
  const a = fileDiffCacheKey("/w", "a.ts", 1);
  assert.notEqual(a, fileDiffCacheKey("/w", "a.ts", 2));
  assert.notEqual(a, fileDiffCacheKey("/w", "b.ts", 1));
  assert.notEqual(a, fileDiffCacheKey("/x", "a.ts", 1));
  assert.equal(a, fileDiffCacheKey("/w", "a.ts", 1));
});

test("文件小标：PDF 另加一句提醒，其他取文件名", () => {
  assert.equal(reviewFileChip("a/b/paper.pdf"), "paper.pdf · 先看是否乱码");
  assert.equal(reviewFileChip("a/b/PAPER.PDF"), "PAPER.PDF · 先看是否乱码");
  assert.equal(reviewFileChip("a/b/notes.md"), "notes.md");
  assert.equal(reviewFileChip("win\\path\\x.txt"), "x.txt");
  assert.equal(reviewFileChip("plain.txt"), "plain.txt");
});
