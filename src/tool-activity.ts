/**
 * 一次工具调用 → 给人看的一行动作（纯逻辑，ConversationView 的过程行用）：「编辑 文件名 目录 +2 −2」
 * 「运行 命令」「搜索 关键词」。2026-10-18 用户：过程里原样摆 JSON 参数太粗糙。
 *
 * 九家的工具名和参数键各不相同（Claude Edit{file_path,old_string,new_string} / Codex apply_patch 补丁正文、
 * exec 脚本里的 tools.exec_command({cmd}) / Gemini replace / OpenCode edit{filePath,oldString,newString} /
 * Kimi StrReplaceFile{path,edit} …），按名字归类、按常见参数键取对象；认不出的照「调用 工具名」，原参数展开可看。
 */

import { normSep, pathWithin, stripVerbatim } from "./path-utils.ts";

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

/** 文件名与目录：工作目录内写相对路径，家目录折成 ~，目录带尾斜杠。
 *  「在工作目录内」走 path-utils（verbatim/分隔符统一，Windows 折叠大小写；isWindows 显式传入） */
export function splitPath(
  path: string,
  cwd: string | null,
  isWindows = false,
): { name: string; dir: string } {
  let p = normSep(stripVerbatim(path));
  const root = cwd ? normSep(stripVerbatim(cwd)).replace(/\/+$/, "") : "";
  if (root && cwd && pathWithin(path, cwd, isWindows)) p = p.slice(root.length + 1);
  else p = p.replace(HOME_RE, "~");
  const idx = p.lastIndexOf("/");
  if (idx < 0) return { name: p, dir: "" };
  return { name: p.slice(idx + 1), dir: p.slice(0, idx + 1) };
}

function shortPath(path: string, cwd: string | null, isWindows: boolean): string {
  const { name, dir } = splitPath(path, cwd, isWindows);
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

/** shell 参数可能是数组（Codex shell：["bash","-lc","…"]；Windows 上 ["…\\pwsh.exe","-Command","…"]） */
function commandOf(args: Args | null): string | null {
  if (!args) return null;
  const c = args.command ?? args.cmd;
  if (typeof c === "string" && c.trim()) return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    const parts = c as string[];
    if (parts.length >= 3 && /(?:^|\/)(?:ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(" ");
    if (POWERSHELL_EXE.test(parts[0])) {
      const at = parts.findIndex((p, i) => i > 0 && /^-(?:command|c)$/i.test(p));
      if (at > 0 && at < parts.length - 1) return parts.slice(at + 1).join(" ");
    }
    return parts.join(" ");
  }
  return null;
}

/**
 * 命令里直接调 apply_patch（Mesa 的连接没有 apply_patch 工具，Codex 让模型在 shell 里调：
 * exec_command {cmd:"apply_patch <<'PATCH'\n*** Begin Patch…", shell:"bash"}），取出补丁正文。
 * 只认 Codex 会接住的写法——argv 形式 ["apply_patch", 补丁]，或 bash / zsh 里整条就是一个 heredoc；
 * PowerShell 里调的、heredoc 前后还串了别的命令的都接不住、文件没改（2026-10-20 Windows 实跑：
 * 这几种都报错，模型改成单独一条 bash heredoc 才改成），不当改文件画
 */
function shellPatchOf(args: Args | null, isWindows: boolean): string | null {
  const raw = args?.command ?? args?.cmd;
  if (Array.isArray(raw) && raw[0] === "apply_patch" && typeof raw[1] === "string") return raw[1];
  const cmd = commandOf(args);
  if (!cmd || !cmd.includes("*** Begin Patch")) return null;
  const shell = str(args, "shell")?.toLowerCase() ?? null;
  const posix = shell ? !/powershell|pwsh|cmd/.test(shell) : !isWindows && unwrapPowerShell(cmd) === null;
  const m = /^apply_patch\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\r?\n([\s\S]*?)\r?\n\2$/.exec(unwrapShell(cmd).trim());
  return posix && m ? m[3] : null;
}

/** PowerShell 程序名（可带 Windows 路径与 .exe） */
const POWERSHELL_EXE = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i;

/**
 * 去掉 Windows 上 Codex 给命令套的 PowerShell 外壳：`"D:\…\pwsh.exe" -Command 'echo …'`、
 * `powershell.exe -NoProfile -Command "…"`（2026-10-20 Windows 实测审批里就是这个样子）。
 * 认不出返回 null；双引号串里有 `$` 不剥（要外层 PowerShell 先展开，剥了含义会变）
 */
export function unwrapPowerShell(command: string): string | null {
  const m =
    /^\s*(?:"[^"]*[\\/]|[A-Za-z]:[\\/](?:[^\s"]*[\\/])?)?(?:pwsh|powershell)(?:\.exe)?"?(?:\s+-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+(?:'((?:[^']|'')*)'|"((?:[^"`]|`.)*)")\s*$/i.exec(
      command,
    );
  if (!m) return null;
  if (m[1] !== undefined) return m[1].replace(/''/g, "'").trim();
  if (m[2].includes("$")) return null;
  return m[2].replace(/`(.)/g, "$1").trim();
}

/** shell 命令再分类（借 vibe-kanban 的 CommandCategory）：读 / 搜 / 看目录的命令归进「查阅」，
 *  改文件的、取网页的、其余照旧算运行。Codex 几乎所有动作都是 exec_command，不分就只能说「运行 6 次」 */
export type CommandCategory = "read" | "search" | "list" | "edit" | "fetch" | "other";

const READ_CMDS = new Set(["cat", "head", "tail", "nl", "less", "more", "wc", "stat", "file", "bat", "jq", "realpath"]);
const SEARCH_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "awk", "which", "locate"]);
const LIST_CMDS = new Set(["ls", "tree", "pwd", "du"]);
const EDIT_CMDS = new Set(["rm", "rmdir", "mv", "cp", "touch", "mkdir", "chmod", "chown", "tee", "truncate", "ln", "patch"]);
const FETCH_CMDS = new Set(["curl", "wget"]);

/** PowerShell 命令（Windows 上 Codex 的命令都是这个）：完整 cmdlet 名任何时候都认，别名只在确认是 PowerShell 时认 */
const PS_CMDLETS: Record<string, CommandCategory> = {
  "get-content": "read", "get-item": "read", "get-itemproperty": "read", "test-path": "read",
  "resolve-path": "read", "format-hex": "read", "get-filehash": "read",
  "select-string": "search", "get-command": "search", "where-object": "search",
  "get-childitem": "list", "get-location": "list", "set-location": "list", "push-location": "list",
  "set-content": "edit", "add-content": "edit", "out-file": "edit", "new-item": "edit", "remove-item": "edit",
  "move-item": "edit", "copy-item": "edit", "rename-item": "edit", "clear-content": "edit",
  "invoke-webrequest": "fetch", "invoke-restmethod": "fetch",
};
const PS_ALIASES: Record<string, CommandCategory> = {
  gc: "read", type: "read", gi: "read", sls: "search", findstr: "search", gci: "list", dir: "list",
  sl: "list", del: "edit", erase: "edit", rd: "edit", ri: "edit", md: "edit", ni: "edit", mi: "edit",
  move: "edit", copy: "edit", cpi: "edit", ren: "edit", sc: "edit", ac: "edit", iwr: "fetch", irm: "fetch",
};
/**
 * cmd 内建命令：Windows 上不套 PowerShell 外壳也会直接发（Qwen 删文件发 `del "…\notes.txt"`，2026-10-20 实跑）。
 * 只收 Unix 上没有同名别义的；`type` 在 bash 里是查命令类型，仍只在 PowerShell 下认
 */
const CMD_BUILTINS: Record<string, CommandCategory> = {
  del: "edit", erase: "edit", rd: "edit", md: "edit", ren: "edit", rename: "edit", copy: "edit", move: "edit", dir: "list",
};

/** 去掉 `bash -lc '…'` / `zsh -lc "…"` 外壳；Windows 上再认 PowerShell 外壳 */
function unwrapShell(command: string): string {
  const m = /^\s*(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2] : (unwrapPowerShell(command) ?? command);
}

function segmentCategory(seg: string, ps = false): CommandCategory {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  // 跳过前置的环境变量赋值（FOO=1 cmd）与 cd 之外的前缀
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  let head = (words[0] ?? "").replace(/^.*\//, "").toLowerCase();
  // Windows 路径写法的程序（C:\…\rg.exe）只留程序名
  if (/^[a-z]:[\\/]/.test(head) || head.endsWith(".exe")) head = head.replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
  if (!head) return "other";
  if (PS_CMDLETS[head]) return PS_CMDLETS[head];
  if (ps && PS_ALIASES[head]) return PS_ALIASES[head];
  if (CMD_BUILTINS[head]) return CMD_BUILTINS[head];
  if (head === "cd") return "list";
  if (head === "sed") return words.some((w) => /^-[a-z]*i/.test(w)) ? "edit" : "read";
  if (head === "git") {
    const sub = words[1] ?? "";
    return ["status", "log", "diff", "show", "blame", "branch", "rev-parse"].includes(sub) ? "read" : "other";
  }
  if (READ_CMDS.has(head)) return "read";
  if (SEARCH_CMDS.has(head)) return "search";
  if (LIST_CMDS.has(head)) return "list";
  if (EDIT_CMDS.has(head)) return "edit";
  if (FETCH_CMDS.has(head)) return "fetch";
  return "other";
}

export function commandCategory(command: string): CommandCategory {
  const trimmed = command.trim();
  const body = unwrapShell(trimmed);
  if (!body) return "other";
  // 套着 PowerShell 外壳的（Windows 上的 Codex）：别名照 PowerShell 认，`> $null` 是丢弃输出
  const ps = unwrapPowerShell(trimmed) !== null;
  const cleaned = body.replace(/2>&1|&>\/dev\/null|>\s*\/dev\/null/g, "");
  // 写到真实文件的重定向就是改文件（2>&1、>/dev/null 不算）
  if (/(^|[^0-9&])>{1,2}\s*(?!&|\/dev\/null)[^\s|&;]+/.test(ps ? cleaned.replace(/>\s*\$null/gi, "") : cleaned)) {
    return "edit";
  }
  const segs = body.split(/&&|\|\||;|\|/).filter((x) => x.trim());
  const cats = segs.map((s) => segmentCategory(s, ps));
  if (cats.includes("edit")) return "edit";
  const looks = cats.filter((c) => c !== "list" || cats.length === 1);
  if (cats.length && cats.every((c) => c === "read" || c === "search" || c === "list")) {
    return (looks.find((c) => c !== "list") ?? cats[0]) as CommandCategory;
  }
  if (cats.includes("fetch") && cats.every((c) => c === "fetch" || c === "read" || c === "search")) return "fetch";
  return "other";
}

/** 读文件类命令里的文件（最后一个不是选项、不像数字范围的参数） */
function commandFileArg(command: string): string | null {
  const body = unwrapShell(command).split(/&&|\|\||;|\|/)[0] ?? "";
  const words = body.trim().split(/\s+/).slice(1).map((w) => w.replace(/^['"]|['"]$/g, ""));
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (!w || w.startsWith("-") || /^\d+(,\d+)?p?$/.test(w) || /^['"]?\d/.test(w)) continue;
    if (/[/.]/.test(w)) return w;
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

function withPath(a: ToolActivity, path: string, cwd: string | null, isWindows: boolean): ToolActivity {
  const { name, dir } = splitPath(path, cwd, isWindows);
  return { ...a, target: name, dir, path };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].trim();
}

/** 一次工具调用拆成的动作（补丁一次改多个文件时是多行） */
export function toolActivities(
  toolName: string | null,
  input: string,
  cwd: string | null,
  isWindows = false,
): ToolActivity[] {
  const name = toolName ?? "tool";
  const args = parseArgs(input);
  const n = normName(name);

  // MCP：mcp__服务__工具
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return [{ ...base("mcp", name, input), target: mcp[2], note: mcp[1] }];

  // 补丁：Codex apply_patch（原文）/ OpenCode patch{patchText} / 脚本里调 apply_patch / shell 命令里调 apply_patch
  const patchText =
    n === "applypatch" || n === "patch" ? (str(args, "input", "patch", "patchText", "patch_text") ?? input) : null;
  const scriptPatch =
    n === "exec" && input.includes("*** Begin Patch") ? input : patchText === null ? shellPatchOf(args, isWindows) : null;
  if (patchText !== null || scriptPatch) {
    const files = parsePatch(patchText ?? scriptPatch ?? "");
    if (files.length) {
      return files.map((f) => {
        const kind: ActivityKind = f.op === "add" ? "write" : f.op === "delete" ? "delete" : "edit";
        const counts = countDiff(f.lines);
        return {
          ...withPath(base(kind, name, input), f.path, cwd, isWindows),
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
    const look = cmds.length === 1 ? lookActivity(a, cmds[0], cwd, null, isWindows) : null;
    if (look) return [look];
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
    if (cmd === "view") return [withPath(base("read", name, input), path, cwd, isWindows)];
    if (cmd === "create") {
      const content = str(args, "file_text", "content") ?? "";
      return [{ ...withPath(base("write", name, input), path, cwd, isWindows), added: lineCount(content), diff: lineDiff("", content) }];
    }
    const diff = lineDiff(str(args, "old_str") ?? "", str(args, "new_str") ?? "");
    return [{ ...withPath(base("edit", name, input), path, cwd, isWindows), ...countDiff(diff), diff }];
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
      const out = filePath ? withPath(a, filePath, cwd, isWindows) : { ...a, target: name };
      return [diff.length ? { ...out, ...countDiff(diff), diff } : out];
    }
    case "write": {
      const content = str(args, "content", "file_text", "contents", "text") ?? "";
      const out = filePath ? withPath(a, filePath, cwd, isWindows) : { ...a, target: name };
      return [{ ...out, added: lineCount(content), removed: null, diff: content ? lineDiff("", content) : null }];
    }
    case "delete":
    case "read":
      return [filePath ? withPath(a, filePath, cwd, isWindows) : { ...a, target: name }];
    case "list":
      return [{ ...a, target: filePath ? shortPath(filePath, cwd, isWindows) || "." : "." }];
    case "search": {
      const pattern = str(args, "pattern", "query", "regex", "glob", "q", "search") ?? name;
      const where = str(args, "path", "dir_path", "directory", "include");
      return [{ ...a, target: pattern, note: where ? shortPath(where, cwd, isWindows) || null : null }];
    }
    case "run": {
      const command = commandOf(args) ?? "";
      const desc = str(args, "description");
      const look = command ? lookActivity(a, command, cwd, desc, isWindows) : null;
      if (look) return [look];
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
      if (filePath) return [{ ...withPath(a, filePath, cwd, isWindows), verb: `调用 ${name}` }];
      if (command) {
        const look = lookActivity({ ...a, kind: "run" }, command, cwd, null, isWindows);
        return [look ?? { ...a, kind: "run", verb: "运行", target: firstLine(command), command }];
      }
      return [{ ...a, target: name }];
    }
  }
}

/** 只读的命令（cat / sed -n / rg / ls …）当成查阅：并进「查阅 · 读了 3 个文件，搜索 2 次」那一行 */
function lookActivity(
  a: ToolActivity,
  command: string,
  cwd: string | null,
  desc: string | null = null,
  isWindows = false,
): ToolActivity | null {
  const cat = commandCategory(command);
  if (cat !== "read" && cat !== "search" && cat !== "list") return null;
  const line = firstLine(unwrapShell(command));
  const file = cat === "read" ? commandFileArg(command) : null;
  const out: ToolActivity = {
    ...a,
    kind: cat,
    verb: VERB[cat],
    target: desc ?? line,
    command,
    note: desc ? line : null,
  };
  return file ? { ...withPath(out, file, cwd, isWindows), note: desc ?? line } : out;
}

/** 前面那页里调用、这页只剩结果的工具（分页截断处） */
export function orphanResultActivity(): ToolActivity {
  return { ...base("other", "", ""), verb: "工具结果" };
}

export type ResultStatus = "ok" | "failed" | "denied" | "interrupted";

/** 工具结果是不是失败 / 被拒绝 / 被中断（只看开头，免得读到的文件正文里碰巧有「Error」）。
 *  isError = CLI 自己标的出错（Claude is_error）：拒绝 / 中断照旧认出来，其余一律算失败——
 *  WebFetch 被拦「Unable to verify if domain …」开头不像报错，原先显示成成功（2026-10-19 实测） */
export function resultStatus(text: string | null, isError = false): ResultStatus {
  if (!text) return isError ? "failed" : "ok";
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
  return isError ? "failed" : "ok";
}

export function resultStatusLabel(s: ResultStatus): string | null {
  return s === "failed" ? "失败" : s === "denied" ? "被拒绝" : s === "interrupted" ? "已中断" : null;
}
