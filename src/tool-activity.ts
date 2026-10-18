/**
 * 一次工具调用 → 给人看的一行动作（纯逻辑，ConversationView 的过程行用）：「编辑 文件名 目录 +2 −2」
 * 「运行 命令」「搜索 关键词」。2026-10-18 用户：过程里原样摆 JSON 参数太粗糙。
 *
 * 九家的工具名和参数键各不相同（Claude Edit{file_path,old_string,new_string} / Codex apply_patch 补丁正文、
 * exec 脚本里的 tools.exec_command({cmd}) / Gemini replace / OpenCode edit{filePath,oldString,newString} /
 * Kimi StrReplaceFile{path,edit} …），按名字归类、按常见参数键取对象；认不出的照「调用 工具名」，原参数展开可看。
 */

export type ActivityKind =
  | "edit"
  | "write"
  | "delete"
  | "read"
  | "search"
  | "list"
  | "run"
  | "web"
  | "task"
  | "todo"
  | "ask"
  | "skill"
  | "mcp"
  | "other";

/** 差异行：「~」是省略掉的未改动段 */
export interface DiffLine {
  op: " " | "+" | "-" | "~";
  text: string;
}

export interface ToolActivity {
  kind: ActivityKind;
  /** 动词：编辑 / 写入 / 运行 / 搜索 … */
  verb: string;
  /** 主对象：文件名 / 命令 / 关键词 / 网址 / 工具名 */
  target: string;
  /** 文件所在目录（工作目录内写相对路径、家目录折成 ~，带尾斜杠；在根上为空串）；不是文件为 null */
  dir: string | null;
  /** 完整路径（展开时显示） */
  path: string | null;
  /** 补一句：命令原文（target 用了说明时）、MCP 服务名、搜索范围 */
  note: string | null;
  added: number | null;
  removed: number | null;
  /** 编辑 / 写入的差异行（展开时画出来） */
  diff: DiffLine[] | null;
  /** 命令原文（展开时显示） */
  command: string | null;
  /** 原始参数（认不出的工具展开时看） */
  input: string;
  toolName: string;
}

const VERB: Record<ActivityKind, string> = {
  edit: "编辑",
  write: "写入",
  delete: "删除",
  read: "读取",
  search: "搜索",
  list: "查看目录",
  run: "运行",
  web: "打开网页",
  task: "子任务",
  todo: "更新待办",
  ask: "问你",
  skill: "使用技能",
  mcp: "调用",
  other: "调用",
};

const NAMES: Array<[ActivityKind, string[]]> = [
  ["edit", ["edit", "multiedit", "replace", "strreplacefile", "strreplace", "editfile", "searchreplace", "notebookedit", "editnotebook"]],
  ["write", ["write", "writefile", "createfile", "writetofile"]],
  ["delete", ["deletefile", "removefile", "delete"]],
  ["read", ["read", "readfile", "readmanyfiles", "viewimage", "view", "notebookread", "readnotebook"]],
  ["search", ["grep", "glob", "searchfilecontent", "grepsearch", "codebasesearch", "filesearch", "find", "findfiles", "ripgrep", "search"]],
  ["list", ["ls", "list", "listdirectory", "listdir", "listfiles"]],
  ["run", ["bash", "shell", "runshellcommand", "execcommand", "runterminalcmd", "runcommand", "runterminalcommand", "localshell", "monitor"]],
  ["web", ["webfetch", "fetchurl", "fetch", "readurl", "websearch", "googlewebsearch", "searchweb"]],
  ["task", ["task", "agent", "subagent", "dispatchagent"]],
  ["todo", ["todowrite", "todoread", "settodolist", "updateplan", "taskcreate", "taskupdate", "writetodos"]],
  ["ask", ["askuserquestion", "requestuserinput", "requestuserinputasync", "askuser", "askfollowupquestion"]],
  ["skill", ["skill"]],
];

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function kindOf(name: string): ActivityKind {
  const n = normName(name);
  for (const [kind, names] of NAMES) if (names.includes(n)) return kind;
  return "other";
}

type Args = Record<string, unknown>;

function parseArgs(text: string): Args | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : null;
  } catch {
    return null;
  }
}

function str(args: Args | null, ...keys: string[]): string | null {
  if (!args) return null;
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;

/** 文件名与目录：工作目录内写相对路径，家目录折成 ~，目录带尾斜杠 */
export function splitPath(path: string, cwd: string | null): { name: string; dir: string } {
  let p = path.replace(/\\/g, "/");
  const root = cwd ? cwd.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (root && (p === root || p.startsWith(`${root}/`))) p = p.slice(root.length + 1);
  else p = p.replace(HOME_RE, "~");
  const idx = p.lastIndexOf("/");
  if (idx < 0) return { name: p, dir: "" };
  return { name: p.slice(idx + 1), dir: p.slice(0, idx + 1) };
}

function shortPath(path: string, cwd: string | null): string {
  const { name, dir } = splitPath(path, cwd);
  return dir + name;
}

/** 两段文本的行级差异：先去掉首尾相同的行，中间按最长公共子序列；太大就整段删 + 整段加 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = [];
  // 未改动的上下文各留两行，再往外的折成「~」
  const ctxBefore = a.slice(Math.max(0, head - 2), head);
  if (head > 2) out.push({ op: "~", text: "" });
  for (const t of ctxBefore) out.push({ op: " ", text: t });
  if (midA.length * midB.length > 250_000) {
    for (const t of midA) out.push({ op: "-", text: t });
    for (const t of midB) out.push({ op: "+", text: t });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ op: " ", text: midA[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        // 同分时先删后加（与 git diff 一致）
        out.push({ op: "-", text: midA[i] });
        i++;
      } else {
        out.push({ op: "+", text: midB[j] });
        j++;
      }
    }
  }
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + 2));
  for (const t of ctxAfter) out.push({ op: " ", text: t });
  if (tail > 2) out.push({ op: "~", text: "" });
  return out;
}

function countDiff(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  return { added, removed };
}

/** 一处或多处替换（Claude MultiEdit edits[] / Kimi edit 可为数组）合成一份差异 */
function editPairs(args: Args): Array<[string, string]> {
  const pick = (o: Args): [string, string] | null => {
    const before = str(o, "old_string", "oldString", "old_str", "old", "search") ?? "";
    const after = str(o, "new_string", "newString", "new_str", "new", "replace") ?? "";
    return before || after ? [before, after] : null;
  };
  const list = Array.isArray(args.edits) ? args.edits : Array.isArray(args.edit) ? args.edit : null;
  if (list) {
    return list
      .filter((e): e is Args => Boolean(e) && typeof e === "object")
      .map(pick)
      .filter((p): p is [string, string] => p !== null);
  }
  if (args.edit && typeof args.edit === "object") {
    const one = pick(args.edit as Args);
    return one ? [one] : [];
  }
  const one = pick(args);
  return one ? [one] : [];
}

interface PatchFile {
  op: "update" | "add" | "delete";
  path: string;
  lines: DiffLine[];
}

/** Codex / OpenCode 补丁正文（*** Begin Patch … *** End Patch）按文件拆开 */
export function parsePatch(text: string): PatchFile[] {
  const body = text.includes("\n") ? text : text.replace(/\\n/g, "\n");
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/.exec(line);
    if (m) {
      cur = { op: m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "update", path: m[2].trim(), lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur || line.startsWith("***")) continue;
    if (line.startsWith("@@")) {
      if (cur.lines.length) cur.lines.push({ op: "~", text: "" });
      continue;
    }
    if (line.startsWith("+")) cur.lines.push({ op: "+", text: line.slice(1) });
    else if (line.startsWith("-")) cur.lines.push({ op: "-", text: line.slice(1) });
    else if (line.startsWith(" ")) cur.lines.push({ op: " ", text: line.slice(1) });
  }
  return files;
}

function unescapeJs(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/** shell 参数可能是数组（Codex shell：["bash","-lc","…"]） */
function commandOf(args: Args | null): string | null {
  if (!args) return null;
  const c = args.command ?? args.cmd;
  if (typeof c === "string" && c.trim()) return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const parts = c as string[];
    if (parts.length >= 3 && /(?:^|\/)(?:ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(" ");
    return parts.join(" ");
  }
  return null;
}

function base(kind: ActivityKind, toolName: string, input: string): ToolActivity {
  return {
    kind,
    verb: VERB[kind],
    target: "",
    dir: null,
    path: null,
    note: null,
    added: null,
    removed: null,
    diff: null,
    command: null,
    input,
    toolName,
  };
}

function withPath(a: ToolActivity, path: string, cwd: string | null): ToolActivity {
  const { name, dir } = splitPath(path, cwd);
  return { ...a, target: name, dir, path };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].trim();
}

/** 一次工具调用拆成的动作（补丁一次改多个文件时是多行） */
export function toolActivities(toolName: string | null, input: string, cwd: string | null): ToolActivity[] {
  const name = toolName ?? "tool";
  const args = parseArgs(input);
  const n = normName(name);

  // MCP：mcp__服务__工具
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return [{ ...base("mcp", name, input), target: mcp[2], note: mcp[1] }];

  // 补丁：Codex apply_patch（原文）/ OpenCode patch{patchText} / 脚本里调 apply_patch
  const patchText =
    n === "applypatch" || n === "patch" ? (str(args, "input", "patch", "patchText", "patch_text") ?? input) : null;
  const scriptPatch = n === "exec" && input.includes("*** Begin Patch") ? input : null;
  if (patchText !== null || scriptPatch) {
    const files = parsePatch(patchText ?? scriptPatch ?? "");
    if (files.length) {
      return files.map((f) => {
        const kind: ActivityKind = f.op === "add" ? "write" : f.op === "delete" ? "delete" : "edit";
        const counts = countDiff(f.lines);
        return {
          ...withPath(base(kind, name, input), f.path, cwd),
          verb: f.op === "add" ? "新建" : VERB[kind],
          added: f.op === "delete" ? null : counts.added,
          removed: f.op === "delete" ? null : counts.removed,
          diff: f.lines.length ? f.lines : null,
        };
      });
    }
  }

  // Codex 脚本模式：exec 的参数是一段 JS，命令在 tools.exec_command({cmd:"…"}) 里
  if (n === "exec" && !args) {
    const cmds = [...input.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeJs(m[1]));
    const a = base("run", name, input);
    if (!cmds.length) return [{ ...a, target: "运行脚本", command: input }];
    return [
      {
        ...a,
        target: firstLine(cmds[0]),
        note: cmds.length > 1 ? `还有 ${cmds.length - 1} 条` : null,
        command: cmds.join("\n"),
      },
    ];
  }

  // Anthropic 文本编辑工具：一个工具按 command 分读 / 建 / 改
  if (n === "strreplacebasededittool" || n === "strreplaceeditor") {
    const cmd = str(args, "command") ?? "";
    const path = str(args, "path", "file_path") ?? "";
    if (cmd === "view") return [withPath(base("read", name, input), path, cwd)];
    if (cmd === "create") {
      const content = str(args, "file_text", "content") ?? "";
      return [{ ...withPath(base("write", name, input), path, cwd), added: lineCount(content), diff: lineDiff("", content) }];
    }
    const diff = lineDiff(str(args, "old_str") ?? "", str(args, "new_str") ?? "");
    return [{ ...withPath(base("edit", name, input), path, cwd), ...countDiff(diff), diff }];
  }

  const kind = kindOf(name);
  const a = base(kind, name, input);
  const filePath =
    str(args, "file_path", "filePath", "absolute_path", "path", "file", "filename", "target_file", "notebook_path") ??
    (Array.isArray(args?.paths) && typeof args?.paths[0] === "string" ? (args?.paths[0] as string) : null);

  switch (kind) {
    case "edit": {
      const pairs = args ? editPairs(args) : [];
      const diff: DiffLine[] = [];
      pairs.forEach(([before, after], i) => {
        if (i > 0) diff.push({ op: "~", text: "" });
        diff.push(...lineDiff(before, after));
      });
      const out = filePath ? withPath(a, filePath, cwd) : { ...a, target: name };
      return [diff.length ? { ...out, ...countDiff(diff), diff } : out];
    }
    case "write": {
      const content = str(args, "content", "file_text", "contents", "text") ?? "";
      const out = filePath ? withPath(a, filePath, cwd) : { ...a, target: name };
      return [{ ...out, added: lineCount(content), removed: null, diff: content ? lineDiff("", content) : null }];
    }
    case "delete":
    case "read":
      return [filePath ? withPath(a, filePath, cwd) : { ...a, target: name }];
    case "list":
      return [{ ...a, target: filePath ? shortPath(filePath, cwd) || "." : "." }];
    case "search": {
      const pattern = str(args, "pattern", "query", "regex", "glob", "q", "search") ?? name;
      const where = str(args, "path", "dir_path", "directory", "include");
      return [{ ...a, target: pattern, note: where ? shortPath(where, cwd) || null : null }];
    }
    case "run": {
      const command = commandOf(args) ?? "";
      const desc = str(args, "description");
      return [
        {
          ...a,
          target: desc ?? (firstLine(command) || name),
          note: desc ? firstLine(command) : null,
          command: command || null,
        },
      ];
    }
    case "web": {
      const url = str(args, "url");
      if (url) {
        let host = url;
        try {
          host = new URL(url).host || url;
        } catch {
          /* 不是完整网址就原样 */
        }
        return [{ ...a, target: host, path: url }];
      }
      return [{ ...a, verb: "搜索网页", target: str(args, "query", "q", "search") ?? name }];
    }
    case "task":
      return [{ ...a, target: str(args, "description", "prompt", "task") ?? name }];
    case "todo": {
      const list = (args?.todos ?? args?.plan ?? args?.items) as unknown;
      const subject = str(args, "subject", "status");
      return [{ ...a, target: Array.isArray(list) ? `${list.length} 项` : (subject ?? "") }];
    }
    case "ask": {
      const qs = args?.questions;
      const q0 = Array.isArray(qs) && qs[0] && typeof qs[0] === "object" ? (qs[0] as Args) : null;
      return [{ ...a, target: str(q0, "question", "title", "header") ?? str(args, "question", "prompt") ?? "" }];
    }
    case "skill":
      return [{ ...a, target: str(args, "skill", "name", "command") ?? name }];
    default: {
      // 认不出的工具：照名字，参数里有路径 / 命令 / 关键词就挑一个当对象
      const command = commandOf(args);
      if (filePath) return [{ ...withPath(a, filePath, cwd), verb: `调用 ${name}` }];
      if (command) return [{ ...a, kind: "run", verb: "运行", target: firstLine(command), command }];
      return [{ ...a, target: name }];
    }
  }
}

/** 前面那页里调用、这页只剩结果的工具（分页截断处） */
export function orphanResultActivity(): ToolActivity {
  return { ...base("other", "", ""), verb: "工具结果" };
}

export type ResultStatus = "ok" | "failed" | "denied" | "interrupted";

/** 工具结果是不是失败 / 被拒绝 / 被中断（只看开头，免得读到的文件正文里碰巧有「Error」） */
export function resultStatus(text: string | null): ResultStatus {
  if (!text) return "ok";
  const head = text.slice(0, 400);
  if (/doesn't want to proceed|tool use was rejected|user rejected|denied by (?:the )?user|用户拒绝/i.test(head)) return "denied";
  if (/^\s*\[?(?:request )?interrupted/i.test(head) || /interrupted by user|已中断/i.test(head)) return "interrupted";
  const first = head.trimStart().split("\n")[0];
  if (
    /^<tool_use_error>/.test(first) ||
    /^(?:error|错误)\s*[:：]/i.test(first) ||
    /^Exit code [1-9]\d*/.test(first) ||
    /Process exited with code [1-9]\d*/.test(head) ||
    /"exit_code"\s*:\s*[1-9]\d*/.test(head) ||
    /permission denied|EACCES|command not found/i.test(first)
  ) {
    return "failed";
  }
  return "ok";
}

export function resultStatusLabel(s: ResultStatus): string | null {
  return s === "failed" ? "失败" : s === "denied" ? "被拒绝" : s === "interrupted" ? "已中断" : null;
}
