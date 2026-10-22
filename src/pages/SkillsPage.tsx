import {
  Download,
  Eye,
  FileDown,
  Folder,
  FolderSearch,
  Import,
  Layers,
  Link,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Tag,
  Trash2,
  WandSparkles,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import { sanitizeDocumentHtml } from "../document-html";
import { splitSkillFrontmatter } from "../skill-preview";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invalidateSkillProvides } from "../skill-slots.ts";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import ContextMenu from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { HoverTip, useHoverTip } from "../components/HoverTip";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../toast";
import {
  isBuiltinSkill,
  skillDeleteImpact,
  skillOriginLabel,
} from "../skill-delete";
import {
  Checkbox,
  EmptyState,
  fieldClass,
  FoldMark,
  LoadingRows,
  PageFrame,
  PageHeader,
  primaryActionClass,
  RowAction,
  rowActionClass,
  secondaryActionClass,
  searchFieldClass,
  hoverRevealClass,
  dangerActionClass,
  NoticeBar,
} from "../components/PageFrame";
import type {
  DiscoveredSkillDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectStepDto,
  SkillDto,
  SkillImportResultDto,
  SkillPathDto,
  SkillUpdateDto,
} from "../types";

const SOURCE_LABEL: Record<string, string> = {
  builtin: "内置",
  ccode: "自建",
  local: "本地",
  zip: "ZIP",
  github: "GitHub",
  discovered: "发现",
};

/** 详情面板描述：空描述或纯符号/标点（无字母数字）视为异常描述，不展示原文 */
function displayDescription(desc: string): string | null {
  const t = desc.trim();
  if (!t) return null;
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}

const GITHUB_PRESETS = [
  "anthropics/skills",
  "ComposioHQ/awesome-claude-skills",
];

/** GitHub 来源的来源链接：仓库根；有子目录拼 /tree/<ref>/<subdir>（ref 缺省用 HEAD） */
function skillRepoUrl(skill: SkillDto): string | null {
  if (skill.source !== "github" || !skill.repo) return null;
  const base = `https://github.com/${skill.repo}`;
  if (!skill.repoSubdir) return base;
  return `${base}/tree/${skill.repoRef ?? "HEAD"}/${skill.repoSubdir}`;
}

/** 应用列单元格：未用 = 浅灰「未用」；已用 = 绿点 + 数量，agent 名收进 tooltip；点击进右侧详情 */
function AppliedCell({
  skill,
  installedIds,
  onOpen,
}: {
  skill: SkillDto;
  /** 本机装了的 Agent（检测还没回来时为 null：不判「漏装」） */
  installedIds: ReadonlySet<string> | null;
  onOpen: () => void;
}) {
  const appliedNames = Object.entries(skill.apps)
    .filter(([, on]) => on)
    .map(([id]) => AGENTS.find((a) => a.id === id)?.label ?? id);
  // 装了却没分发到的 Agent：只有这种「部分应用」值得点一下，全装上不画点（每行一样的绿点等于没说）
  const missingNames = installedIds
    ? Object.entries(skill.apps)
        .filter(([id, on]) => !on && installedIds.has(id))
        .map(([id]) => AGENTS.find((a) => a.id === id)?.label ?? id)
    : [];
  const anchorRef = useRef<HTMLButtonElement>(null);
  const { tip, show, hide } = useHoverTip(anchorRef);
  const has = appliedNames.length > 0;
  return (
    <button
      ref={anchorRef}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onMouseEnter={has ? show : undefined}
      onMouseLeave={hide}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-seg-sel"
    >
      {/* 写「N 个 Agent」不写「N 处」；只有部分应用画琥珀点，全装上 / 未用都不画（2026-10-23 审查） */}
      {has && missingNames.length > 0 && (
        <span className="size-1.5 shrink-0 rounded-full bg-warn-text" />
      )}
      <span className="text-l3 hover:text-l1">
        {has ? `${appliedNames.length} 个 Agent` : "未用"}
      </span>
      {has && (
        <HoverTip
          tip={tip}
          text={`已用：${appliedNames.join("、")}${
            missingNames.length ? `\n还没用：${missingNames.join("、")}` : ""
          }\n点击在右侧管理`}
        />
      )}
    </button>
  );
}

/** 行内徽标悬浮底座：纯展示锚点 + 共享 HoverTip（原生 title 在 WKWebView 渲染白块且不稳定，
 *  与 MCP 页 HealthDot / 本页 AppliedCell 同一口径）；非交互元素，事件直接挂在自身 span 上 */
function TipBadge({
  text,
  className,
  children,
}: {
  text: string;
  className: string;
  children?: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(anchorRef);
  return (
    <span
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      className={className}
    >
      {children}
      <HoverTip tip={tip} text={text} />
    </span>
  );
}

/** 来源标签纯文本：GitHub 来源为 owner/repo[/subdir]，其余来源保留类型标签。
 *  行级来源列已拆除（2026-08-25 设计评审：逐行重复分组标题信息是噪音）——
 *  用于组头「单来源组」标注；具体可点击的仓库链接在预览面板 */
function sourceLabel(skill: SkillDto): string {
  return skill.repo
    ? skill.repo + (skill.repoSubdir ? `/${skill.repoSubdir}` : "")
    : (SOURCE_LABEL[skill.source] ?? skill.source);
}

/** 把用户粘贴的 GitHub 网址/简写统一解析为 { repo, branch, subdir }：
 *  支持 owner/repo、github.com/owner/repo、https://github.com/owner/repo.git、
 *  /tree/<branch>/<subdir> 形式 */
function parseGithubInput(raw: string): {
  repo: string;
  branch: string | null;
  subdir: string | null;
} {
  let s = raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
  const parts = s.split("/").filter(Boolean);
  const repo = parts.slice(0, 2).join("/");
  let branch: string | null = null;
  let subdir: string | null = null;
  if (parts[2] === "tree" && parts.length > 3) {
    branch = parts[3];
    if (parts.length > 4) subdir = parts.slice(4).join("/");
  } else if (parts.length > 2) {
    subdir = parts.slice(2).join("/");
  }
  return { repo, branch, subdir };
}

function ImportModal({
  initialGithub,
  onClose,
  onDone,
}: {
  initialGithub?: { repo: string; branch: string; subdir: string };
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [tab, setTab] = useState<"dir" | "zip" | "github">(
    initialGithub ? "github" : "dir",
  );
  const [repo, setRepo] = useState(initialGithub?.repo ?? "");
  const [branch, setBranch] = useState(initialGithub?.branch ?? "");
  const [subdir, setSubdir] = useState(initialGithub?.subdir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillImportResultDto | null>(null);
  const [lastRequest, setLastRequest] = useState<{
    cmd: string;
    args: Record<string, unknown>;
  } | null>(null);
  const [renameTargets, setRenameTargets] = useState<Record<string, string>>(
    {},
  );

  function summary(value: SkillImportResultDto): string {
    const parts = [
      value.added.length ? `新增 ${value.added.length}` : "",
      value.updated.length ? `覆盖更新 ${value.updated.length}` : "",
      value.skipped.length ? `跳过 ${value.skipped.length}` : "",
      value.conflicts.length ? `冲突 ${value.conflicts.length}` : "",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "未发现可导入技能";
  }

  async function run(
    cmd: string,
    args: Record<string, unknown>,
    resolutions: Record<string, string> | null = null,
  ) {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<SkillImportResultDto>(cmd, {
        ...args,
        resolutions,
      });
      setLastRequest({ cmd, args });
      // 冲突「另存为」成功的技能计入 next.added，必须并入首轮新增
      const combined = result
        ? {
            added: [...new Set([...result.added, ...next.added])],
            updated: [...new Set([...result.updated, ...next.updated])],
            skipped: next.skipped.filter(
              (name) => !result.added.includes(name),
            ),
            conflicts: next.conflicts,
          }
        : next;
      setResult(combined);
      setRenameTargets(
        Object.fromEntries(
          combined.conflicts.map((conflict) => [
            conflict.name,
            renameTargets[conflict.name] ?? `${conflict.name}-copy`,
          ]),
        ),
      );
      if (combined.added.length > 0 || combined.updated.length > 0) {
        onDone(summary(combined));
      }
      if (combined.conflicts.length === 0) {
        if (combined.added.length === 0 && combined.updated.length === 0) {
          onDone(summary(combined));
        }
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflicts(action: "overwrite" | "skip" | "rename") {
    if (!lastRequest || !result) return;
    const resolutions: Record<string, string> = {};
    for (const name of result.added) resolutions[name] = "skip";
    for (const conflict of result.conflicts) {
      resolutions[conflict.name] =
        action === "rename"
          ? `rename:${(renameTargets[conflict.name] ?? "").trim()}`
          : action;
    }
    await run(lastRequest.cmd, lastRequest.args, resolutions);
  }

  async function pickDir() {
    const path = await open({ directory: true, multiple: false });
    if (!path) return;
    await run("import_skills_from_dir", { path });
  }

  async function pickZip() {
    const path = await open({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return;
    await run("import_skills_from_zip", { path });
  }

  const tabBtn = (k: typeof tab, label: string) => (
    <button
      key={k}
      onClick={() => setTab(k)}
      className={`rounded-sm px-2.5 py-1 text-xs ${
        tab === k ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal open title="导入技能" onClose={onClose} size="md">
        <div className="mb-4 flex gap-1">
          {tabBtn("dir", "本地目录")}
          {tabBtn("zip", "ZIP 文件")}
          {tabBtn("github", "GitHub 仓库")}
        </div>
        {tab === "dir" && (
          <p className="text-xs text-l3">
            选择包含技能（SKILL.md）的目录。
          </p>
        )}
        {tab === "zip" && (
          <p className="text-xs text-l3">选择技能打包的 .zip 文件。</p>
        )}
        {tab === "github" && (
          <div>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {GITHUB_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setRepo(p)}
                  className="rounded-sm bg-inset px-1.5 py-0.5 text-xs text-l3 hover:text-l1"
                >
                  {p}
                </button>
              ))}
            </div>
            <label className="mb-2 block text-sm">
              <span className="mb-1 block text-xs text-l3">仓库</span>
              <input
                className={fieldClass}
                placeholder="anthropics/skills 或 https://github.com/owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <label className="block flex-1 text-sm">
                <span className="mb-1 block text-xs text-l3">分支（可选）</span>
                <input
                  className={fieldClass}
                  placeholder="main"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <label className="block flex-1 text-sm">
                <span className="mb-1 block text-xs text-l3">
                  子目录（可选）
                </span>
                <input
                  className={fieldClass}
                  placeholder="skills/pdf"
                  value={subdir}
                  onChange={(e) => setSubdir(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}
        {busy && tab !== "github" && !result && (
          <p className="mt-2 text-xs text-l3">导入中…</p>
        )}
        {result && (
          <div className="mt-3 rounded-sm border border-field ccode-well p-3 text-xs">
            <p className="text-l2">{summary(result)}</p>
            {result.added.length > 0 && (
              <p className="mt-1 break-words text-l2">
                <span className="text-ok-text">新增</span>：{result.added.join("、")}
              </p>
            )}
            {result.updated.length > 0 && (
              <p className="mt-1 break-words text-l2">
                <span className="text-warn-text">已覆盖</span>：{result.updated.join("、")}
              </p>
            )}
            {result.skipped.length > 0 && (
              <p className="mt-1 break-words text-l3">
                已跳过：{result.skipped.join("、")}
              </p>
            )}
            {result.conflicts.length > 0 && (
              <div className="mt-2 space-y-2 border-t border-hairline pt-2">
                {result.conflicts.map((conflict) => (
                  <div
                    key={conflict.name}
                    className="grid grid-cols-[1fr_150px] items-center gap-2"
                  >
                    <span
                      className="min-w-0 truncate text-warn-text"
                      title={conflict.name}
                    >
                      {conflict.name}
                      {conflict.updateAvailable
                        ? " · GitHub 更新"
                        : " · 同名冲突"}
                    </span>
                    <input
                      value={renameTargets[conflict.name] ?? ""}
                      onChange={(event) =>
                        setRenameTargets((current) => ({
                          ...current,
                          [conflict.name]: event.target.value,
                        }))
                      }
                      aria-label={`${conflict.name} 另存为名称`}
                      className="rounded-sm border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none focus:border-l4"
                    />
                  </div>
                ))}
                <p className="text-l4">
                  覆盖会先备份旧库目录；另存为使用右侧名称。
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("skip")}
                    disabled={busy}
                    className="rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    跳过冲突
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("rename")}
                    disabled={
                      busy ||
                      result.conflicts.some(
                        (item) => !renameTargets[item.name]?.trim(),
                      )
                    }
                    className={secondaryActionClass}
                  >
                    全部另存为
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolveConflicts("overwrite")}
                    disabled={busy}
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    备份并覆盖
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
        <div className="mt-4 flex justify-end gap-2">
          {tab === "dir" && (
            <button
              type="button"
              onClick={pickDir}
              disabled={busy}
              className={primaryActionClass}
            >
              {busy ? "导入中…" : "选择目录…"}
            </button>
          )}
          {tab === "zip" && (
            <button
              type="button"
              onClick={pickZip}
              disabled={busy}
              className={primaryActionClass}
            >
              {busy ? "导入中…" : "选择 ZIP…"}
            </button>
          )}
          {tab === "github" && (
            <button
              type="button"
              onClick={() => {
                const parsed = parseGithubInput(repo);
                void run("import_skills_from_github", {
                  repo: parsed.repo,
                  branch: branch.trim() || parsed.branch,
                  subdir: subdir.trim() || parsed.subdir,
                });
              }}
              disabled={busy || !repo.trim()}
              className={primaryActionClass}
            >
              {busy ? "下载中…" : "导入"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={secondaryActionClass}
          >
            关闭
          </button>
        </div>
    </Modal>
  );
}

function DiscoverModal({
  items,
  onClose,
  onDone,
}: {
  items: DiscoveredSkillDto[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    new Set(items.map((i) => i.path)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importSelected() {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<SkillImportResultDto>("import_discovered", {
        paths: [...checked],
      });
      const conflictNote = r.conflicts.length
        ? `，${r.conflicts.length} 个与库中同名被跳过（可在「导入」中选择覆盖或另存为）`
        : "";
      onDone(`已导入 ${r.added.length} 个技能${conflictNote}`);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="发现未纳管技能" onClose={onClose} size="md">
        {items.length === 0 ? (
          <p className="mb-4 text-sm text-l4">
            各 agent 目录里没有发现未纳管的技能
          </p>
        ) : (
          <div className="mb-4 max-h-64 overflow-auto">
            {items.map((it) => (
              <Checkbox
                key={it.path}
                checked={checked.has(it.path)}
                onChange={(isChecked) => {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (isChecked) next.add(it.path);
                    else next.delete(it.path);
                    return next;
                  });
                }}
                align="start"
                className="border-b border-hairline py-2 text-sm"
                label={
                  <span className="min-w-0">
                    <span className="mr-2 text-l1">{it.name}</span>
                    <span className="rounded-sm bg-inset px-1 text-xs text-l3">
                      {it.fromAgent}
                    </span>
                    <span
                      className="block truncate text-xs text-l3"
                      title={it.description}
                    >
                      {it.description}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        )}
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          {items.length > 0 && (
            <button
              onClick={importSelected}
              disabled={busy || checked.size === 0}
              className={primaryActionClass}
            >
              {busy ? "导入中…" : `导入选中（${checked.size}）`}
            </button>
          )}
        </div>
    </Modal>
  );
}

/** 删除确认弹层（删除保护，与 MCP 收编条目弹层同思路但语义不同——技能删除没有
 *  「保留 agent 侧副本」选项：分发出去的本就是 Mesa 管的链接/带标记副本，删除即回收）：
 *  所有技能列出影响面（apps 已分发的 agent）；内置种子额外警告不会复活；
 *  外部导入提示来源；删除前库目录自动备份（delete_impl 先备份再卸载，保留最近 5 份）。 */
function DeleteSkillModal({
  skill,
  derivedChildren,
  onClose,
  onConfirm,
}: {
  skill: SkillDto;
  /** 从本技能合成的新技能名单（纯提示：独立副本，不受删除影响） */
  derivedChildren: string[];
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const impact = skillDeleteImpact(skill.apps, AGENTS);
  const origin = skillOriginLabel(skill);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`删除技能「${skill.name}」？`} onClose={onClose} size="md">
        {isBuiltinSkill(skill.source) && (
          <p className="mb-1 text-xs leading-5 text-warn-text">
            这是内置技能：删除后不会随启动恢复（内置技能只在种子升级时补播缺失的，
            不复活已删除的）。
          </p>
        )}
        {origin && (
          <p className="mb-1 text-xs leading-5 text-l3">来源：{origin}。</p>
        )}
        {impact.length > 0 && (
          <p className="mb-1 text-xs leading-5 text-l3">
            将从以下 agent 的技能目录移除：{impact.join("、")}
            （只移除 Mesa 分发的副本/链接，你自己放的同名内容不受影响）。
          </p>
        )}
        {derivedChildren.length > 0 && (
          <p className="mb-1 text-xs leading-5 text-l3">
            有技能从它合成：{derivedChildren.join("、")}
            （独立副本，不受本次删除影响）。
          </p>
        )}
        <p className="mb-1 text-xs leading-5 text-l4">
          删除前会把技能库目录自动备份（每个技能保留最近 5 份），需要时可从备份手动找回。
        </p>
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="mt-4 flex justify-end gap-2">
          {/* 焦点默认给取消（HIG：破坏性动作不做默认按钮），与全局确认框同口径 */}
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={dangerActionClass}
          >
            {busy ? "删除中…" : "删除"}
          </button>
        </div>
    </Modal>
  );
}

/** 编辑预填：剥掉 SKILL.md 的 frontmatter 只留正文（frontmatter 由表单字段在保存时重新生成） */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return m ? text.slice(m[0].length).replace(/^(\r?\n)+/, "") : text;
}

/** 新建/编辑技能（RX3b）：名称=目录名（编辑时锁定）、描述一句话、正文即 SKILL.md 主体。
 *  保存走后端 create_skill / update_skill_content（覆盖前自动备份旧库目录）。 */
function SkillEditorModal({
  mode,
  skill,
  initialBody,
  draft,
  onClose,
  onDone,
}: {
  mode: "create" | "edit";
  skill?: SkillDto;
  initialBody?: string;
  /** 「✦ 沉淀为技能」AI 草稿预填（仅 create） */
  draft?: { name: string; description: string; content: string };
  onClose: () => void;
  /** editedId 用于保存后刷新正在展示的预览面板 */
  onDone: (msg: string, editedId?: string) => void;
}) {
  const [name, setName] = useState(draft?.name ?? skill?.name ?? "");
  const [description, setDescription] = useState(
    draft?.description ?? skill?.description ?? "",
  );
  const [content, setContent] = useState(initialBody ?? draft?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await invoke("create_skill", {
          name: name.trim(),
          description: description.trim(),
          content,
        });
        onDone(`已创建技能「${name.trim()}」，打开 agent 开关即可分发`);
      } else if (skill) {
        await invoke("update_skill_content", {
          name: skill.name,
          content,
          description: description.trim(),
        });
        onDone(`已保存「${skill.name}」（旧版本已自动备份）`, skill.id);
      }
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={mode === "create" ? "新建技能" : `编辑技能：${skill?.name}`}
      onClose={onClose}
      size="lg"
    >
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            名称（即目录名，单个安全名称）
          </span>
          <input
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={mode === "edit"}
            placeholder="如 paper-notes"
          />
        </label>
        <label className="mb-2 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            描述（一句话，列表与步骤推荐里展示）
          </span>
          <input
            className={fieldClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个技能帮 Agent 做什么"
          />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">
            正文（SKILL.md 主体，frontmatter 由名称/描述自动生成）
          </span>
          <textarea
            className={`${fieldClass} h-56 resize-y font-mono text-xs`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="把你的工作方法写在这里：步骤、规范、注意事项……"
          />
        </label>
        {mode === "edit" && (
          <p className="mb-2 text-xs text-l4">
            保存会先备份当前版本（保留最近 5 份），SKILL.md 之外的辅助文件不受影响。
          </p>
        )}
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim() || !content.trim()}
            className={primaryActionClass}
          >
            {busy ? "保存中…" : mode === "create" ? "创建" : "保存"}
          </button>
        </div>
    </Modal>
  );
}

/** ◈ 优化技能（RX3b）：去向二选一——原地改（开终端让 Agent 直改库文件，现状行为）｜
 *  另存为新技能（多选源技能 → AI 按人的优化方向合成出稿 → 预览/再编辑 → 确认落库，
 *  源技能零触碰）。一个入口一个主 CTA，按钮文案随去向切换。 */
function OptimizeModal({
  skill,
  skillLib,
  onClose,
  onConfirm,
  onCreated,
}: {
  skill: SkillDto;
  skillLib: SkillDto[] | null;
  onClose: () => void;
  /** 原地改路径：意见 → 开终端（现状行为不变） */
  onConfirm: (opinion: string) => Promise<void>;
  /** 另存路径：新技能落库后回调（预览面板/刷新由父级处理） */
  onCreated: (created: SkillDto) => Promise<void>;
}) {
  const [mode, setMode] = useState<"terminal" | "new">("terminal");
  const [opinion, setOpinion] = useState("");
  const [sources, setSources] = useState<Set<string>>(new Set([skill.id]));
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "terminal") {
        await onConfirm(opinion.trim());
        onClose();
        return;
      }
      // 另存：第一阶段出稿（不写盘）
      const ids = [...sources];
      const dto = await invoke<{ name: string; content: string }>("optimize_skills_draft", {
        ids,
        direction: opinion.trim(),
      });
      setDraft({ name: dto.name || "", content: dto.content });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreate() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const created = await invoke<SkillDto>("create_user_skill", {
        fullText: draft.content,
        name: draft.name.trim(),
        derivedFrom: (skillLib ?? [])
          .filter((s) => sources.has(s.id))
          .map((s) => s.name),
      });
      await onCreated(created);
      onClose();
    } catch (reason) {
      // 撞名错误在另存语境下指错方向（“改用编辑内容”会引导覆盖源技能）：补一句本语境指引
      const msg = String(reason);
      setError(msg.includes("已存在") ? `${msg}——换个新技能名再试；源技能不要动` : msg);
    } finally {
      setBusy(false);
    }
  }

  // 另存路径的预览/编辑阶段：全文可见可改，provides 行显形（它决定流程入口点亮，必须让人看见）
  if (mode === "new" && draft) {
    return (
      <Modal open title={`◈ 优化另存：${skill.name}`} onClose={onClose} size="lg">
        <p className="mb-3 text-xs text-l3">
          AI 合成稿如下，可再改；确认后作为新技能落库，源技能零触碰。frontmatter 里的
          provides 行决定它能顶替哪个内置位（流程里换上后对应入口才点亮）。
        </p>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-l3">新技能名（可改）</span>
          <input
            className={fieldClass}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <textarea
          className={`${fieldClass} mb-3 min-h-64 flex-1 resize-y font-mono text-xs`}
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
            disabled={busy}
            className={secondaryActionClass}
          >
            返回重选
          </button>
          <button
            onClick={() => void confirmCreate()}
            disabled={busy || !draft.content.trim() || !draft.name.trim()}
            className={primaryActionClass}
          >
            {busy ? "落库中…" : "确认落库为新技能"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title={`◈ 优化技能：${skill.name}`} onClose={onClose} size="md">
        {/* 去向分段：唯一入口内部二选一，不增第二套入口 */}
        <div className="mb-3 flex gap-1 rounded-sm border border-hairline p-1 text-sm">
          {([["terminal", "原地改（开终端）"], ["new", "另存为新技能（AI 出稿）"]] as const).map(
            ([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`flex-1 rounded-sm px-2 py-1 ${mode === value ? "bg-active text-l1" : "text-l3 hover:bg-hover"}`}
              >
                {label}
              </button>
            ),
          )}
        </div>
        {mode === "terminal" ? (
          <p className="mb-3 text-xs text-l3">开终端让 Agent 按你的意见改写这个技能；改完记得审查。</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-l3">
              AI 按你的优化方向把勾选的技能合成一份新技能（内置源的流水线落点为骨架）；
              出稿后预览可改，确认才落库，源技能零触碰。
            </p>
            <div className="mb-3 max-h-64 overflow-auto rounded-sm border border-hairline">
              {(skillLib ?? []).map((s) => (
                <Checkbox
                  key={s.id}
                  disabled={busy}
                  checked={sources.has(s.id)}
                  onChange={(checked) => {
                    const next = new Set(sources);
                    if (checked) next.add(s.id);
                    else next.delete(s.id);
                    setSources(next);
                  }}
                  className="border-b border-hairline px-3 py-2 text-sm last:border-b-0"
                  label={
                    <span className="text-l2">
                      {s.name}
                      {isBuiltinSkill(s.source) && (
                        <span className="ml-2 text-xs text-l4">内置</span>
                      )}
                    </span>
                  }
                />
              ))}
            </div>
          </>
        )}
        <textarea
          autoFocus
          className={`${fieldClass} mb-3 h-24 resize-y`}
          value={opinion}
          onChange={(e) => setOpinion(e.target.value)}
          placeholder={
            mode === "terminal"
              ? "优化意见，如：补充中文输出格式约定；把检查清单精简到 5 条"
              : "优化方向，如：把我的检索习惯融进内置流程，保留严格档；检查清单按我们组的口径重写"
          }
        />
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !opinion.trim() || (mode === "new" && sources.size === 0)}
            className={primaryActionClass}
          >
            {busy
              ? mode === "terminal"
                ? "打开中…"
                : "AI 出稿中…"
              : mode === "terminal"
                ? "开终端优化"
                : `AI 合成（${sources.size} 个源）`}
          </button>
        </div>
    </Modal>
  );
}

/** ◈ 适配到流水线：成稿在后台生成。这里只预览已有稿，确认才写回。 */
function AdaptModal({
  skill,
  initialContent,
  initialError,
  unchanged = false,
  onClose,
  onSaved,
  onRetry,
}: {
  skill: SkillDto;
  initialContent: string | null;
  initialError: string | null;
  unchanged?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onRetry: () => void;
}) {
  const [content, setContent] = useState(initialContent ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function confirm() {
    if (!content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("write_skill_md", { name: skill.name, fullText: content });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={`◈ 适配到流水线：${skill.name}`}
      onClose={onClose}
      size="lg"
    >
        <p className="mb-3 text-xs text-l3">
          AI 按流水线路径约定（papers/、notes/、references.bib
          等）改写技能，并补写 inputs/outputs 接口声明；可再手动改，确认后才写回技能库。
        </p>
        {unchanged ? (
          <p className="mb-3 text-xs text-l3">
            这份技能的路径和顶位声明已经符合流水线，没有重写。下面是原文，确认会原样写回。
          </p>
        ) : null}
        {content.trim() ? (
          <textarea
            className={`${fieldClass} mb-3 min-h-64 flex-1 resize-y font-mono text-xs`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        ) : (
          <p className="py-8 text-center text-sm text-l4">还没有适配稿。</p>
        )}
        {error && <NoticeBar tone="err" className="mb-2">{error}</NoticeBar>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className={secondaryActionClass}
          >
            取消
          </button>
          {error && (
            <button
              onClick={onRetry}
              disabled={busy}
              className={secondaryActionClass}
            >
              重试
            </button>
          )}
          <button
            onClick={() => void confirm()}
            disabled={busy || !content.trim()}
            className={primaryActionClass}
          >
            {busy ? "处理中…" : "确认写回技能库"}
          </button>
        </div>
    </Modal>
  );
}

/** 挂载到步骤（反向入口）：选项目 → 选步骤，把当前技能追加进 project.toml steps[].skills。
 *  已挂载的步骤置灰；写回走 update_step_skills（读-改-原子写）。 */
function BindToStepModal({
  skill,
  onClose,
  onBound,
}: {
  skill: SkillDto;
  onClose: () => void;
  onBound: (msg: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState("");
  const [steps, setSteps] = useState<ProjectStepDto[] | "loading" | "error">(
    "loading",
  );
  const [stepsTick, setStepsTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadProjects() {
    setProjects(null);
    setProjectsError(null);
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setProjectPath((cur) => cur || list[0].path);
      })
      .catch((reason) => setProjectsError(String(reason)));
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (!projectPath) return;
    setSteps("loading");
    setError(null);
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => setSteps(read.config.steps))
      .catch((reason) => {
        // 读取失败不能伪装成“没有步骤”或一直“读取中”。
        setSteps("error");
        setError(`读取项目研究流程失败：${String(reason)}`);
      });
  }, [projectPath, stepsTick]);

  async function bind(step: ProjectStepDto) {
    if (busy || step.skills.includes(skill.name)) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("update_step_skills", {
        projectRoot: projectPath,
        stepName: step.name,
        skills: [...step.skills, skill.name],
      });
      onBound(`已挂载到「${step.name}」`);
      onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`挂载到步骤：${skill.name}`} onClose={onClose} size="md">
        <p className="mb-3 text-xs text-l3">
          把技能挂到项目研究流程的某一步；下次开工 TASK.md 的「本步骤技能」段会列出它。
        </p>
        {projectsError ? (
          <div className="py-6 text-center">
            <p className="text-sm text-err-text">读取项目列表失败：{projectsError}</p>
            <button
              type="button"
              className="mt-2 rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              onClick={() => loadProjects()}
            >
              重试
            </button>
          </div>
        ) : projects === null ? (
          <p className="py-6 text-center text-sm text-l4">读取项目列表…</p>
        ) : projects.length === 0 ? (
          <p className="py-6 text-center text-sm text-l4">
            还没有注册项目——先在项目页注册并配好研究流程
          </p>
        ) : (
          <>
            <select
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              className={`${fieldClass} mb-2`}
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="max-h-56 overflow-auto rounded-sm border border-field">
              {steps === "loading" ? (
                <p className="px-3 py-4 text-center text-xs text-l4">
                  读取步骤…
                </p>
              ) : steps === "error" ? (
                <div className="px-3 py-4 text-center">
                  <button
                    type="button"
                    className="text-xs text-l2 hover:bg-hover rounded-sm px-2 py-1"
                    onClick={() => setStepsTick((n) => n + 1)}
                  >
                    重新读取步骤
                  </button>
                </div>
              ) : steps.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-l4">
                  该项目还没有研究流程步骤
                </p>
              ) : (
                steps.map((step) => {
                  const mounted = step.skills.includes(skill.name);
                  return (
                    <button
                      key={step.name}
                      type="button"
                      disabled={mounted || busy}
                      onClick={() => void bind(step)}
                      title={
                        mounted ? "该步骤已挂载此技能" : `挂载到「${step.name}」`
                      }
                      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-l2 hover:bg-hover disabled:opacity-50"
                    >
                      <span className="min-w-0 truncate">{step.name}</span>
                      <span className="shrink-0 text-micro text-l4">
                        {mounted ? "已挂载" : "＋ 挂载"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
        {error && <NoticeBar tone="err" className="mt-2">{error}</NoticeBar>}
        <div className="mt-3 flex justify-end">
          <button
            onClick={onClose}
            className={secondaryActionClass}
          >
            关闭
          </button>
        </div>
    </Modal>
  );
}

export default function SkillsPage({ visible }: { visible: boolean }) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [catCollapsed, setCatCollapsed] = useState<Set<string>>(new Set());
  function toggleCat(cat: string) {
    setCatCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | {
        kind: "import";
        github?: { repo: string; branch: string; subdir: string };
      }
    | { kind: "discover" }
    | null
  >(null);
  const [discovered, setDiscovered] = useState<DiscoveredSkillDto[]>([]);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{
    skill: SkillDto;
    content: string;
  } | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    skill: SkillDto;
  } | null>(null);
  const [topMenu, setTopMenu] = useState<{ x: number; y: number } | null>(null);
  const [updates, setUpdates] = useState<Record<string, SkillUpdateDto>>({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // 内置技能新版提示：加载时 best-effort 检测；更新失败行内报错（按技能名记录）
  const [builtinUpdates, setBuiltinUpdates] = useState<string[]>([]);
  const [builtinPreview, setBuiltinPreview] = useState<{ name: string; revision: string; files: { path: string; current: string; proposed: string }[] } | null>(null);
  const [builtinApplying, setBuiltinApplying] = useState<string | null>(null);
  const [builtinErrors, setBuiltinErrors] = useState<Record<string, string>>(
    {},
  );
  // ◈ 技能翻译（英文技能友好）：ai_prompt 一次性调用，译文随会话缓存（skill.id → 译文），
  // 只读展示不写库文件；切换技能各自缓存
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const translation = preview
    ? (translations[preview.skill.id] ?? null)
    : null;
  // SKILL.md 预览默认按 Markdown 渲染（frontmatter 拆成字段表）；「源码」切回原文等宽
  const [skillSourceView, setSkillSourceView] = useState(false);
  const shownSkillText = preview
    ? translation && !showOriginal
      ? translation
      : preview.content
    : "";
  const skillDoc = useMemo(() => {
    const { fields, body } = splitSkillFrontmatter(shownSkillText);
    return {
      // name / description 面板顶部已经写过，不再列一遍
      fields: fields.filter((f) => f.key !== "name" && f.key !== "description"),
      html: sanitizeDocumentHtml(
        marked.parse(body, { gfm: true, breaks: false, async: false }) as string,
      ),
    };
  }, [shownSkillText]);

  async function toggleTranslation() {
    if (!preview) return;
    if (translation) {
      setShowOriginal((v) => !v);
      return;
    }
    setTranslating(true);
    try {
      // 超出 8KB 截断（长文档翻核心部分），prompt 显式要求保留 Markdown 结构
      const text = preview.content.slice(0, 8192);
      const zh = await invoke<string>("ai_prompt", {
        profileId: null,
        fnKey: "translate",
        prompt: `把以下技能文档翻译为中文，保持 Markdown 结构与代码块原样，只输出译文，不要任何解释：\n\n${text}`,
      });
      setTranslations((m) => ({ ...m, [preview.skill.id]: zh.trim() }));
      setShowOriginal(false);
    } catch (reason) {
      setError(`翻译失败：${String(reason)}`);
    } finally {
      setTranslating(false);
    }
  }
  // 技能编辑器（RX3b）：create=空白表单（可带 AI 草稿预填）；edit=预填名称/描述/正文（名称锁定）
  const [editor, setEditor] = useState<
    | {
        mode: "create";
        draft?: { name: string; description: string; content: string };
      }
    | { mode: "edit"; skill: SkillDto; body: string }
    | null
  >(null);
  // ◈ 优化：内联收集意见后开终端让 Agent 改写 SKILL.md
  const [optimize, setOptimize] = useState<SkillDto | null>(null);
  // ◈ 适配到流水线（AI 改写稿预览确认）与反向挂载到步骤
  const [adapt, setAdapt] = useState<SkillDto | null>(null);
  const skillAdaptJobs = useAppStore((s) => s.skillAdaptJobs);
  const skillAdaptOpenId = useAppStore((s) => s.skillAdaptOpenId);
  const startSkillAdapt = useAppStore((s) => s.startSkillAdapt);
  const markSkillAdaptOpened = useAppStore((s) => s.markSkillAdaptOpened);
  const clearSkillAdapt = useAppStore((s) => s.clearSkillAdapt);
  const setSkillAdaptOpenId = useAppStore((s) => s.setSkillAdaptOpenId);

  useEffect(() => {
    if (!skillAdaptOpenId) return;
    const skill = skills.find((item) => item.id === skillAdaptOpenId);
    if (!skill) return;
    setAdapt(skill);
    markSkillAdaptOpened(skill.id);
    setSkillAdaptOpenId(null);
  }, [markSkillAdaptOpened, setSkillAdaptOpenId, skillAdaptOpenId, skills]);

  function openAdapt(skill: SkillDto) {
    const job = skillAdaptJobs[skill.id];
    if (job?.status === "running") {
      toast(`「${skill.name}」的适配稿还在生成`);
      return;
    }
    if (job?.status === "ready" && job.content) {
      markSkillAdaptOpened(skill.id);
      setAdapt(skill);
      return;
    }
    if (job?.status === "error") {
      setAdapt(skill);
      return;
    }
    startSkillAdapt({ id: skill.id, name: skill.name });
    toast(`正在后台生成「${skill.name}」的适配稿，完成后在待你处理里通知`);
  }
  const [bindSkill, setBindSkill] = useState<SkillDto | null>(null);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const agents = useAppStore((s) => s.agents);
  // 列表「N 个 Agent」判部分应用用：检测数据没回来时不判
  const installedAgentIds = useMemo(
    () =>
      agents.length ? new Set(agents.filter((a) => a.binaryPath).map((a) => a.id)) : null,
    [agents],
  );

  async function refresh() {
    try {
      const list = await invoke<SkillDto[]>("list_skills");
      setSkills(list);
      // 技能库刚变过：失效行为键用的 provides 缓存（导入/新建/编辑/更新/删除都经 refresh 回刷）
      invalidateSkillProvides();
      // 预览面板跟随最新数据（resync/分类等变化），技能消失时关闭预览
      setPreview((prev) => {
        if (!prev) return prev;
        const fresh = list.find((item) => item.id === prev.skill.id);
        return fresh ? { ...prev, skill: fresh } : null;
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (visible) void refresh();
  }, [visible]);

  // 内置技能新版检测：失败必须可见，避免把“检查失败”误认为“没有更新”
  useEffect(() => {
    if (!visible) return;
    invoke<string[]>("check_builtin_skill_updates")
      .then(setBuiltinUpdates)
      .catch((reason) => {
        setBuiltinUpdates([]);
        setError(`检查内置技能更新失败：${String(reason)}`);
      });
  }, [visible]);

  /** 一键更新内置技能为官方最新版（覆盖前自动备份）；成功移出提示条并刷新列表 */
  async function onApplyBuiltinUpdate(name: string, expectedRevision: string) {
    if (builtinApplying) return;
    setBuiltinApplying(name);
    setBuiltinErrors((prev) => ({ ...prev, [name]: "" }));
    try {
      await invoke("apply_builtin_skill_update", { name, expectedRevision });
      setBuiltinUpdates((prev) => prev.filter((n) => n !== name));
      setNotice(`内置技能「${name}」已更新到最新版（原文件已备份）`);
      setError(null);
      await refresh();
    } catch (e) {
      setBuiltinErrors((prev) => ({ ...prev, [name]: String(e) }));
    } finally {
      setBuiltinApplying(null);
    }
  }

  // 选段「✦ 沉淀为技能」交来的 AI 草稿：打开新建 modal 预填（同 focusTabReq 一次性消费模式）
  const skillDraftReq = useAppStore((s) => s.skillDraftReq);
  const setSkillDraftReq = useAppStore((s) => s.setSkillDraftReq);
  useEffect(() => {
    if (!visible || !skillDraftReq) return;
    setEditor({ mode: "create", draft: skillDraftReq });
    setSkillDraftReq(null);
  }, [visible, skillDraftReq, setSkillDraftReq]);

  /** 切换某 agent 的应用开关（apply_skill），按钮级 spinner */
  async function toggleApp(skill: SkillDto, agent: string) {
    const key = `${skill.id}:${agent}`;
    if (applying[key]) return;
    setApplying((prev) => ({ ...prev, [key]: true }));
    try {
      await invoke("apply_skill", {
        id: skill.id,
        agent,
        enabled: !skill.apps[agent],
      });
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id
            ? { ...s, apps: { ...s.apps, [agent]: !s.apps[agent] } }
            : s,
        ),
      );
      // 乐观更新后拉取最新 appModes/staleCopies
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying((prev) => ({ ...prev, [key]: false }));
    }
  }

  /** 一键应用：把技能分发到所有尚未启用的 agent（仅限该技能 apps 表中列出的，即规格声明了技能目录的）。
   *  未安装的 agent 跳过并告知——CLI 不在时分发只会往它的配置目录塞没人读的副本
   *  （如这台电脑没装的 cursor-agent）。detect 数据未就位（agents 为空）时不过滤，退回旧行为 */
  async function applyAllAgents(skill: SkillDto) {
    const key = `${skill.id}:__all__`;
    if (applying[key]) return;
    const known = new Set(agents.map((a) => a.id));
    const installed = new Set(
      agents.filter((a) => a.binaryPath).map((a) => a.id),
    );
    const pending = Object.keys(skill.apps).filter((a) => !skill.apps[a]);
    const filterOn = agents.length > 0;
    const targets = filterOn
      ? pending.filter((a) => !known.has(a) || installed.has(a))
      : pending;
    const skipped = filterOn
      ? pending.filter((a) => known.has(a) && !installed.has(a))
      : [];
    if (skipped.length > 0) {
      setNotice(
        `已跳过未安装的 ${skipped.map((a) => AGENTS.find((g) => g.id === a)?.label ?? a).join("、")}`,
      );
    }
    if (targets.length === 0) return;
    setApplying((prev) => ({ ...prev, [key]: true }));
    try {
      for (const agent of targets) {
        await invoke("apply_skill", { id: skill.id, agent, enabled: true });
      }
      // 乐观更新后拉取最新 appModes/staleCopies
      await refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
      await refresh();
    } finally {
      setApplying((prev) => ({ ...prev, [key]: false }));
    }
  }

  const [catEdit, setCatEdit] = useState<{ id: string; value: string } | null>(
    null,
  );
  // Enter 提交未完成时 input 失焦会触发第二次提交，用 guard 挡住
  const catSubmitting = useRef(false);

  async function submitCategory(id: string, value: string) {
    if (catSubmitting.current) return;
    catSubmitting.current = true;
    try {
      await invoke("set_skill_category", {
        id,
        category: value.trim() || null,
      });
      setCatEdit(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      catSubmitting.current = false;
    }
  }

  const [tagEdit, setTagEdit] = useState<{ id: string; value: string } | null>(
    null,
  );
  const tagSubmitting = useRef(false);

  async function submitTags(id: string, value: string) {
    if (tagSubmitting.current) return;
    tagSubmitting.current = true;
    try {
      // 逗号/空格分隔（含中文逗号），去空去重，超 4 个截断；留空 = 清除全部标签
      const tags = [
        ...new Set(
          value
            .split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ].slice(0, 4);
      await invoke("set_skill_tags", { id, tags });
      setTagEdit(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      tagSubmitting.current = false;
    }
  }

  async function onView(skill: SkillDto) {
    try {
      const content = await invoke<string>("read_skill_md", { id: skill.id });
      setPreview({ skill, content });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 编辑内容：读 SKILL.md 剥掉 frontmatter 预填编辑器表单 */
  async function onEdit(skill: SkillDto) {
    try {
      const full = await invoke<string>("read_skill_md", { id: skill.id });
      setEditor({ mode: "edit", skill, body: stripFrontmatter(full) });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** ◈ 优化：以技能库目录为 cwd 开终端，预填「阅读 + 按意见优化」指令（Agent 直接改写库文件） */
  async function confirmOptimize(skill: SkillDto, opinion: string) {
    try {
      const target = await invoke<SkillPathDto>("skill_md_path", {
        id: skill.id,
      });
      setPendingTerminal({
        cwd: target.dir,
        extraEnv: {},
        title: `优化技能 ${skill.name}`,
        initialPrompt: `阅读 ${target.mdPath}，按以下意见优化它：\n${opinion}`,
      });
      setPage("terminal");
    } catch (e) {
      setError(`打开技能优化终端失败：${String(e)}`);
    }
  }

  /** 副本过期：把库里的最新版本重新分发到漂移的 agent 副本 */
  async function onResync(skill: SkillDto) {
    try {
      const agents = await invoke<string[]>("resync_skill_copies", {
        id: skill.id,
      });
      setNotice(agents.length ? `已同步：${agents.join("、")}` : "副本已同步");
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // 删除确认改走 DeleteSkillModal 弹层（影响面/来源/内置警告/备份说明集中在弹层里）
  const [deleteTarget, setDeleteTarget] = useState<SkillDto | null>(null);

  async function confirmDelete(skill: SkillDto) {
    await invoke("delete_skill", { id: skill.id });
    if (preview?.skill.id === skill.id) setPreview(null);
    await refresh();
  }

  // 一键应用 GitHub 更新：按安装时记录的 repo/ref/subdir 下载并覆盖（自动备份），只动该技能
  const [applyingUpdate, setApplyingUpdate] = useState<string | null>(null);
  async function onApplyUpdate(skill: SkillDto) {
    if (applyingUpdate) return;
    if (
      !(await confirmDialog(
        `将下载 ${skill.repo} 最新版本并覆盖技能「${skill.name}」（覆盖前自动备份，同仓库其他技能不受影响）。继续？`,
      ))
    )
      return;
    setApplyingUpdate(skill.id);
    try {
      await invoke("apply_skill_update", { id: skill.id });
      setNotice(`技能「${skill.name}」已更新到 GitHub 最新版本`);
      setUpdates((prev) => ({
        ...prev,
        [skill.id]: {
          ...prev[skill.id],
          updateAvailable: false,
          message: "已是 GitHub 最新版本",
        },
      }));
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplyingUpdate(null);
    }
  }

  async function onExport(ids: string[], defaultName: string) {
    try {
      const destPath = await save({
        defaultPath: defaultName,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!destPath) return;
      const out = await invoke<string>("export_skills", { ids, destPath });
      setNotice(`已导出：${out}`);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDiscover() {
    try {
      const items = await invoke<DiscoveredSkillDto[]>("discover_unmanaged");
      setDiscovered(items);
      setModal({ kind: "discover" });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setNotice("正在检查 GitHub 更新…");
    try {
      const items = await invoke<SkillUpdateDto[]>("check_skill_updates");
      setUpdates(Object.fromEntries(items.map((item) => [item.id, item])));
      setNotice(
        items.length ? "GitHub 技能更新检查完成" : "没有可检查的 GitHub 技能",
      );
      setError(null);
    } catch (reason) {
      setNotice(null);
      setError(String(reason));
    } finally {
      setCheckingUpdates(false);
    }
  }

  // 存量回填：自动分类（#15）落地前导入的 GitHub 技能没有分类，按仓库名补上；已有分类不动
  async function onBackfillCategories() {
    try {
      const n = await invoke<number>("backfill_skill_categories");
      setNotice(
        n ? `已按仓库名补充分类：${n} 个技能` : "没有需要补充分类的 GitHub 技能",
      );
      setError(null);
      if (n) await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const appliedCount = skills.filter((s) =>
    Object.values(s.apps).some(Boolean),
  ).length;
  // 技能一多（内置 14 + 自建 + GitHub 导入）就只能靠肉眼在分组里找（v3.88 补搜索）。
  // 范围 = 名称 + 描述 + 分类 + 来源，正文搜索留二期（要后端支持）
  const [query, setQuery] = useState("");
  // 「哪些步骤在用」反查（v3.88）：打开预览时扫一次已注册项目的 project.toml，
  // null = 查询中。纯读，不轮询；单个项目读失败静默跳过（未注册/档案卡缺失是常态）
  const [skillUsage, setSkillUsage] = useState<
    { projectPath: string; projectName: string; step: string }[] | null
  >(null);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);

  useEffect(() => {
    if (!preview) {
      setSkillUsage(null);
      return;
    }
    let stale = false;
    const name = preview.skill.name;
    setSkillUsage(null);
    void (async () => {
      const hits: { projectPath: string; projectName: string; step: string }[] = [];
      try {
        const projects = await invoke<ProjectDto[]>("list_projects");
        for (const p of projects) {
          try {
            const read = await invoke<ProjectConfigReadDto>(
              "read_project_config",
              { path: p.path },
            );
            for (const st of read.config.steps)
              if (st.skills.includes(name))
                hits.push({ projectPath: p.path, projectName: p.name, step: st.name });
          } catch {
            /* 未注册/档案卡缺失是常态，跳过 */
          }
        }
      } catch {
        /* 列不出项目就当没有 */
      }
      if (!stale) setSkillUsage(hits);
    })();
    return () => {
      stale = true;
    };
  }, [preview]);
  const q = query.trim().toLowerCase();
  const matched = q
    ? skills.filter((sk) =>
        [sk.name, sk.description, sk.category ?? "", sk.source ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(q),
      )
    : skills;

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <PageFrame width="wide">
          <PageHeader
            title="技能"
            meta={`${skills.length} 个 · 已应用 ${appliedCount}`}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setEditor({ mode: "create" })}
                  className={primaryActionClass}
                >
                  + 创建技能
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTopMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                  }}
                  title="更多技能操作"
                  aria-label="更多技能操作"
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
                >
                  ⋯
                </button>
              </>
            }
          />
          {builtinPreview && (
            <section
              className="mb-3 rounded-md ccode-well p-3 text-xs"
              aria-label="内置技能更新预览"
            >
              <h3 className="text-sm font-medium text-l1">
                {builtinPreview.name}：本机与新版对照
              </h3>
              <p className="mt-0.5 text-l4">
                不会自动覆盖。采用新版前会先备份本机文件；你自己改过的内容不会自动合并。
              </p>
              <div className="mt-2 space-y-1.5">
                {builtinPreview.files.map((file) => {
                  const same = file.current === file.proposed;
                  return (
                    <details
                      key={file.path}
                      className="rounded-md border border-hairline bg-canvas"
                    >
                      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-l2 hover:bg-hover">
                        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                        <span className={same ? "text-l4" : "text-warn-text"}>
                          {same ? "未变" : "有差异"}
                        </span>
                      </summary>
                      <div className="grid grid-cols-2 gap-2 border-t border-hairline p-2">
                        <div className="min-w-0">
                          <div className="mb-1 text-micro text-l4">本机</div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm ccode-well p-2 font-mono text-l3">
                            {file.current || "（尚无）"}
                          </pre>
                        </div>
                        <div className="min-w-0">
                          <div className="mb-1 text-micro text-l4">新版</div>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm ccode-well p-2 font-mono text-l2">
                            {file.proposed}
                          </pre>
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className={secondaryActionClass}
                  onClick={() => setBuiltinPreview(null)}
                >
                  保留本机版本
                </button>
                <button
                  type="button"
                  className={primaryActionClass}
                  disabled={builtinApplying !== null}
                  onClick={async () => {
                    if (
                      await confirmDialog(
                        "将备份本机文件再更新所列技能文件。自改内容不会自动合并，确认采用新版？",
                        { confirmText: "备份并更新" },
                      )
                    ) {
                      await onApplyBuiltinUpdate(builtinPreview.name, builtinPreview.revision);
                      setBuiltinPreview(null);
                    }
                  }}
                >
                  {builtinApplying ? "更新中…" : "备份并采用新版"}
                </button>
              </div>
            </section>
          )}
          {builtinUpdates.length > 0 && (
            <div className="mb-3 rounded-md ccode-well px-3 py-2 text-xs text-l3">
              <p>
                内置技能有新版：{builtinUpdates.join("、")}（共{" "}
                {builtinUpdates.length}{" "}
                个）——更新会用官方最新版覆盖库内副本，原文件自动备份为
                SKILL.md.bak
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {builtinUpdates.map((name) => (
                  <span key={name} className="inline-flex items-center gap-1.5">
                    <span className="text-l2">{name}</span>
                    <button
                      type="button"
                      disabled={builtinApplying !== null}
                      onClick={() => { void invoke<{ revision: string; files: { path: string; current: string; proposed: string }[] }>("preview_builtin_skill_update", { name }).then((preview) => setBuiltinPreview({ name, ...preview })).catch((e) => setBuiltinErrors((prev) => ({ ...prev, [name]: String(e) }))); }}
                      className={rowActionClass}
                    >
                      {builtinApplying === name ? "更新中…" : "查看差异"}
                    </button>
                    {builtinErrors[name] ? (
                      <span className="text-err-text">
                        {builtinErrors[name]}
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          )}
          {error && <NoticeBar tone="err" className="mb-3" onDismiss={() => setError(null)}>{error}</NoticeBar>}
          {notice && <NoticeBar className="mb-3" onDismiss={() => setNotice(null)}>{notice}</NoticeBar>}
          {loading ? (
            <LoadingRows />
          ) : skills.length === 0 ? (
            <EmptyState
              title="还没有技能"
              detail="导入现有技能，或把自己的研究方法新建为可复用技能。"
              action={
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditor({ mode: "create" })}
                    className={primaryActionClass}
                  >
                    创建技能
                  </button>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: "import" })}
                    className={secondaryActionClass}
                  >
                    导入技能
                  </button>
                </div>
              }
            />
          ) : (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-2">
                <input
                  // 不给宽度时 input 按默认 20 字符宽，占位字后半截「/ 来源）」被截掉
                  className={`w-full max-w-md ${searchFieldClass}`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索技能（名称 / 描述 / 分类 / 来源）"
                  aria-label="搜索技能"
                />
                {q && (
                  <span className="shrink-0 text-micro text-l4">
                    {matched.length} / {skills.length}
                  </span>
                )}
              </div>
              {q && matched.length === 0 && (
                <p className="py-6 text-center text-xs text-l4">
                  没有匹配「{query}」的技能
                </p>
              )}
              {/* 分组卡片化（2026-08-25 设计评审）：同组技能裹进 field 细边 + strip 底卡片，
                  组内行收窄 hover 不再通栏、不再重复来源列；列表不再伪装成贯穿整页的表格，
                  列对齐只在卡片内部成立（名称 | 应用 | 操作） */}
              <div>
                {[
                  // 分组顺序 = 技能数组首现顺序；未分类固定沉底（不挡已归组的内容）
                  ...new Set(matched.map((skill) => skill.category ?? "未分类")),
                ]
                  .sort((a, b) => (a === "未分类" ? 1 : b === "未分类" ? -1 : 0))
                  .map((category) => {
                  const categorySkills = matched.filter(
                    (skill) => (skill.category ?? "未分类") === category,
                  );
                  // 组内来源全部一致时收进组头标一次（行级不再逐行重复）；混合来源不标，明细在预览面板
                  const distinctSources = [
                    ...new Set(categorySkills.map((s) => sourceLabel(s))),
                  ];
                  // 分组名已含来源字样（「Mesa 内置」组再标「内置」）时不重复
                  const groupSource =
                    distinctSources.length === 1 &&
                    !category.includes(distinctSources[0]!)
                      ? distinctSources[0]
                      : null;
                  return (
                    <section
                      key={category}
                      className="mb-3 overflow-hidden ccode-well ccode-card"
                    >
                      <button
                        type="button"
                        onClick={() => toggleCat(category)}
                        aria-label={
                          catCollapsed.has(category) ? "展开" : "收起"
                        }
                        className="flex h-10 w-full items-center gap-1.5 px-3 text-sm transition-colors hover:bg-hover/60"
                      >
                        <FoldMark open={!catCollapsed.has(category)} boxed />
                        {/* 分组标题加深到 l1（原 l3 太淡层级不清）；计数改微型胶囊 */}
                        <span className="font-medium text-l1">{category}</span>
                        <span className="rounded-full bg-inset px-1.5 py-0.5 text-micro text-l4">
                          {categorySkills.length} 个技能
                        </span>
                        {/* 单来源组的来源标注（替代原行级来源列）；嵌在折叠按钮内只能纯展示，
                            仓库链接在预览面板 */}
                        {groupSource && (
                          <span
                            className="truncate font-mono text-micro text-l4"
                            title={`来源：${groupSource}`}
                          >
                            {groupSource}
                          </span>
                        )}
                        {/* 未分类组挂归类引导（实际入口是行内 ⋯ → 设置分类，无拖拽归类） */}
                        {category === "未分类" && (
                          <span className="ml-1 text-micro text-l4">
                            — 行内 ⋯ →「设置分类」即可归档
                          </span>
                        )}
                      </button>
                      {!catCollapsed.has(category) && (
                        // 卡片体内留白：行 hover 带收进内边距与圆角内，不通栏切断分组边界
                        <div className="border-t border-hairline px-2 pb-2 pt-1">
                        <ul className="space-y-0.5">
                          {categorySkills.map((skill) => {
                            const stale = (skill.staleCopies ?? []).length > 0;
                            const update = updates[skill.id];
                            return (
                              <li
                                key={skill.id}
                                onClick={() => void onView(skill)}
                                className={`group grid min-h-10 cursor-pointer grid-cols-[minmax(0,1fr)_120px_92px] items-center gap-3 rounded-md border border-transparent py-1.5 pl-5 pr-2 transition-colors hover:bg-hover ${
                                  preview?.skill.id === skill.id
                                    ? "border-hairline bg-inset"
                                    : ""
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="flex min-w-0 items-center gap-1.5">
                                    <span className="min-w-0 truncate text-sm font-medium text-l1">
                                      {skill.name}
                                    </span>
                                    {/* 类型标签（v3.93）：有后端数据支撑的只有 MCP 提及
                                        （skills.rs 内容扫描）；Prompt/Tool 分类无来源，不编造 */}
                                    {skill.mentionsMcp && (
                                      <TipBadge
                                        text="SKILL.md 正文提及 MCP 工具/服务器"
                                        className="shrink-0 rounded-sm bg-inset px-1 py-0.5 font-mono text-micro text-l3"
                                      >
                                        ⌗ MCP
                                      </TipBadge>
                                    )}
                                    {/* 用户自定义标签 pill：名称后 1-4 个，无标签不渲染 */}
                                    {(skill.tags ?? []).slice(0, 4).map((tag) => (
                                      <span
                                        key={tag}
                                        className="h-5 max-w-24 shrink-0 truncate rounded-full bg-inset px-1.5 text-xs leading-5 text-l2"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    {/* 状态聚合：副本过期/GitHub 可更新合并为一个警示点，明细在悬浮 */}
                                    {(stale || update?.updateAvailable) && (
                                      <TipBadge
                                        className="size-2 shrink-0 rounded-full bg-warn-text"
                                        text={[
                                          stale
                                            ? `副本过期：${(skill.staleCopies ?? []).join("、")}。点「同步副本」重新分发。`
                                            : "",
                                          update?.updateAvailable
                                            ? update.message
                                            : "",
                                        ]
                                          .filter(Boolean)
                                          .join("\n")}
                                      />
                                    )}
                                    {stale && (
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void onResync(skill);
                                        }}
                                        title={`把库里的最新版重新拷到：${(skill.staleCopies ?? []).join("、")}`}
                                        className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
                                      >
                                        同步副本
                                      </button>
                                    )}
                                  </div>
                                  {/* 描述次行：名称下挂一行简介提升扫视效率（来源列拆除后横向空间
                                      释放，2026-10-23 去掉宽度上限、铺到「已用」列前；对比度提到 xs/l3，米白底色上 micro/l4 太暗）；
                                      空/纯符号描述不渲染（displayDescription 同预览面板口径） */}
                                  {(() => {
                                    const desc = displayDescription(
                                      skill.description,
                                    );
                                    return desc ? (
                                      <div className="mt-0.5 truncate text-xs text-l3">
                                        {desc}
                                      </div>
                                    ) : null;
                                  })()}
                                  {catEdit?.id === skill.id && (
                                    <input
                                      autoFocus
                                      onClick={(event) => event.stopPropagation()}
                                      value={catEdit.value}
                                      onChange={(event) =>
                                        setCatEdit({
                                          id: skill.id,
                                          value: event.target.value,
                                        })
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                          void submitCategory(
                                            skill.id,
                                            catEdit.value,
                                          );
                                        if (event.key === "Escape")
                                          setCatEdit(null);
                                      }}
                                      onBlur={() =>
                                        void submitCategory(
                                          skill.id,
                                          catEdit.value,
                                        )
                                      }
                                      placeholder="分类名（留空=未分类）"
                                      className="mt-1 w-full rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2 outline-none"
                                    />
                                  )}
                                  {tagEdit?.id === skill.id && (
                                    <input
                                      autoFocus
                                      onClick={(event) => event.stopPropagation()}
                                      value={tagEdit.value}
                                      onChange={(event) =>
                                        setTagEdit({
                                          id: skill.id,
                                          value: event.target.value,
                                        })
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                          void submitTags(
                                            skill.id,
                                            tagEdit.value,
                                          );
                                        if (event.key === "Escape")
                                          setTagEdit(null);
                                      }}
                                      onBlur={() =>
                                        void submitTags(skill.id, tagEdit.value)
                                      }
                                      placeholder="标签（逗号/空格分隔，最多 4 个，留空=清除）"
                                      className="mt-1 w-full rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l2 outline-none"
                                    />
                                  )}
                                </div>
                                <AppliedCell
                                  skill={skill}
                                  installedIds={installedAgentIds}
                                  onOpen={() => void onView(skill)}
                                />
                                {/* 行内高频操作（2026-08-24 起与 MCP 页同口径）：裸图标钮 hover 淡入，
                                    不套胶囊容器——实体栏压在列表行上层级脱节；tooltip 挂按钮上方（RowAction） */}
                                <div className="flex items-center justify-end">
                                  <div className={`flex items-center ${hoverRevealClass} focus-within:opacity-100`}>
                                    <RowAction
                                      icon={<Pencil size={14} strokeWidth={1.8} aria-hidden="true" />}
                                      tip="编辑内容"
                                      label={`编辑 ${skill.name}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void onEdit(skill);
                                      }}
                                    />
                                    <RowAction
                                      icon={<WandSparkles size={14} strokeWidth={1.8} aria-hidden="true" />}
                                      tip="优化：开终端让 Agent 按你的意见改写"
                                      label={`优化 ${skill.name}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOptimize(skill);
                                      }}
                                    />
                                    <RowAction
                                      icon={<MoreHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />}
                                      tip="更多操作"
                                      label={`${skill.name} 更多操作`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect =
                                          e.currentTarget.getBoundingClientRect();
                                        setRowMenu({
                                          x: rect.right - 176,
                                          y: rect.bottom + 4,
                                          skill,
                                        });
                                      }}
                                    />
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}
        </PageFrame>
      </div>

      {/* SKILL.md 预览面板 */}
      {preview && (
        <div className="ccode-skill-preview flex w-[clamp(360px,34vw,460px)] shrink-0 flex-col border-l border-hairline bg-canvas">
          <div className="flex h-11 shrink-0 items-center gap-2 bg-strip px-3">
            <span className="truncate text-sm font-semibold text-l1">
              {preview.skill.name}
            </span>
            <button
              onClick={() => setPreview(null)}
              title="关闭预览"
              aria-label="关闭预览"
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1"
            >
              ×
            </button>
          </div>
          {/* 描述/来源/应用网格与 SKILL.md 同在一个滚动区（v3.47：顶部固定区曾挡掉内容上半部分）；
              描述全文展示，不再截断；空或纯符号的异常值显示占位 */}
          <div className="min-h-0 flex-1 overflow-auto">
          <div className="border-b border-hairline px-3 py-2.5 text-sm leading-5 text-l3">
            {displayDescription(preview.skill.description) ?? (
              <span className="text-l4">—</span>
            )}
          </div>
          {/* 哪些步骤在用（v3.88）：删技能前得知道会影响谁——这条以前完全没有。
              纯前端反查已注册项目的 steps[].skills，打开预览时读一次，不轮询 */}
          <div className="border-b border-hairline px-3 py-2.5 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-l4">哪些步骤在用</span>
              <button
                type="button"
                onClick={() => setBindSkill(preview.skill)}
                title="选项目与步骤，把此技能挂进研究流程（写回 project.toml）"
                className="rounded-sm px-1 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
              >
                ＋ 挂载到步骤
              </button>
            </div>
            {skillUsage === null ? (
              <span className="text-xs text-l4">查询中…</span>
            ) : skillUsage.length === 0 ? (
              <span className="text-xs text-l4" title="删除它不会影响现有研究流程">
                没有步骤在用
              </span>
            ) : (
              <ul className="space-y-0.5">
                {skillUsage.map((u) => (
                  <li key={`${u.projectPath}/${u.step}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectProjectReq(u.projectPath);
                        setPage("workspaces");
                      }}
                      title={`到项目页查看 ${u.projectName}`}
                      className="flex w-full min-w-0 items-baseline gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-hover"
                    >
                      <span className="shrink-0 text-l4">{u.projectName}</span>
                      <span className="min-w-0 truncate text-l2">{u.step}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-b border-hairline px-3 py-2.5 text-sm text-l3">
            <span>
              {SOURCE_LABEL[preview.skill.source] ?? preview.skill.source}
              {preview.skill.derivedFrom?.length
                ? `｜从 ${preview.skill.derivedFrom
                    .filter((d) => skills.some((s) => s.name === d.name))
                    .map((d) => d.name)
                    .join("、")} 合成`
                : ""}
            </span>
            {preview.skill.repo &&
              (() => {
                const url = skillRepoUrl(preview.skill);
                return url ? (
                  <button
                    type="button"
                    onClick={() => void openUrl(url)}
                    className="ml-2 font-mono text-l2 underline decoration-white/20 underline-offset-2 hover:text-l1"
                    title={`在浏览器打开 ${url}`}
                  >
                    {preview.skill.repo}
                    {preview.skill.repoSubdir ? `/${preview.skill.repoSubdir}` : ""}
                  </button>
                ) : (
                  <span
                    className="ml-2 font-mono text-l2"
                    title={preview.skill.repo}
                  >
                    {preview.skill.repo}
                    {preview.skill.repoSubdir ? `/${preview.skill.repoSubdir}` : ""}
                  </span>
                );
              })()}
            {(preview.skill.staleCopies ?? []).length > 0 && (
              <>
                <span
                  className="ml-2 text-warn-text"
                  title={`分发给 Agent 的复制件过期：${(preview.skill.staleCopies ?? []).join("、")}。不是 GitHub 更新，点「同步副本」把库里的最新版重新拷过去。`}
                >
                  副本需同步
                </span>
                <button
                  type="button"
                  onClick={() => void onResync(preview.skill)}
                  className="ml-2 flex h-7 items-center rounded-sm px-2 text-xs text-cta-text bg-cta hover:opacity-90"
                >
                  同步副本
                </button>
              </>
            )}
            {updates[preview.skill.id]?.updateAvailable && (
              <span
                className="ml-2 text-warn-text"
                title={updates[preview.skill.id].message}
              >
                GitHub 可更新
              </span>
            )}
            {updates[preview.skill.id]?.updateAvailable && (
              <button
                type="button"
                onClick={() => void onApplyUpdate(preview.skill)}
                disabled={applyingUpdate === preview.skill.id}
                className="ml-2 flex h-7 items-center rounded-sm px-2 text-xs text-cta-text bg-cta hover:opacity-90 disabled:opacity-50"
              >
                {applyingUpdate === preview.skill.id ? "正在更新…" : "应用更新"}
              </button>
            )}
          </div>
          <div className="border-b border-hairline bg-strip px-3 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium text-l2">
                应用到 Agent
              </span>
              {(() => {
                const allKey = `${preview.skill.id}:__all__`;
                // 与 applyAllAgents 同口径：检测数据就位时只数已安装的（未装的点了也会被跳过）
                const installedIds = new Set(
                  agents.filter((a) => a.binaryPath).map((a) => a.id),
                );
                const remaining = Object.keys(preview.skill.apps).filter(
                  (a) =>
                    !preview.skill.apps[a] &&
                    (agents.length === 0 || installedIds.has(a)),
                ).length;
                if (remaining === 0) return null;
                return (
                  <button
                    type="button"
                    onClick={() => void applyAllAgents(preview.skill)}
                    disabled={applying[allKey]}
                    title={`分发到剩余 ${remaining} 个未启用的 Agent`}
                    className="flex h-7 items-center rounded-sm px-2 text-xs text-cta-text bg-cta hover:opacity-90 disabled:opacity-50"
                  >
                    {applying[allKey] ? "应用中…" : "一键应用"}
                  </button>
                );
              })()}
              <span
                className="ml-auto text-xs text-l4"
                title="已应用 / 全部 CLI"
              >
                {Object.values(preview.skill.apps).filter(Boolean).length}/
                {AGENTS.length}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {AGENTS.map((agent) => {
                const enabled = !!preview.skill.apps[agent.id];
                const key = `${preview.skill.id}:${agent.id}`;
                // 本机没装的 CLI 降权显示：分发过去也没人读（已启用的仍照常显示，便于取消）
                const notInstalled =
                  agents.length > 0 &&
                  !agents.some((a) => a.id === agent.id && a.binaryPath);
                const mode = enabled
                  ? (preview.skill.appModes ?? {})[agent.id]
                  : undefined;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => void toggleApp(preview.skill, agent.id)}
                    disabled={
                      applying[key] ||
                      applying[`${preview.skill.id}:__all__`]
                    }
                    title={
                      enabled
                        ? `${mode === "copy" ? "copy（有漂移检测）" : "symlink"}；点击取消应用${notInstalled ? "（本机未安装这个 CLI）" : ""}`
                        : notInstalled
                          ? `本机未安装 ${agent.label}，应用后也没有 CLI 读取；仍可点击预先分发`
                          : `应用到 ${agent.label}`
                    }
                    className={`flex h-9 items-center gap-2 rounded-md border px-2 text-sm transition-colors disabled:opacity-50 ${
                      enabled
                        ? "border-cta-bd bg-inset text-l1"
                        : notInstalled
                          ? "border-hairline bg-canvas text-l4 hover:bg-inset hover:text-l3"
                          : "border-hairline bg-canvas text-l3 hover:bg-inset hover:text-l1"
                    }`}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        enabled ? "bg-ok-text" : "bg-l4"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {agent.label}
                    </span>
                    {notInstalled && !applying[key] && (
                      <span className="shrink-0 text-micro text-l4">未安装</span>
                    )}
                    {applying[key] && <span className="text-l4">…</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wide text-l4">
              SKILL.md
              <button
                type="button"
                onClick={() => setSkillSourceView((v) => !v)}
                title={skillSourceView ? "按 Markdown 排版显示" : "显示原文（含 YAML 头）"}
                className="rounded-sm px-1.5 py-0.5 text-xs font-normal text-l3 hover:bg-hover hover:text-l1"
              >
                {skillSourceView ? "排版" : "源码"}
              </button>
              {/* 英文技能一键翻译（◈ ai_prompt 一次性调用，结果随会话缓存；不改动库文件） */}
              <button
                type="button"
                disabled={translating}
                onClick={() => void toggleTranslation()}
                className="ml-auto rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {translating
                  ? "翻译中…"
                  : translation
                    ? showOriginal
                      ? "显示译文"
                      : "显示原文"
                    : "◈ 翻译为中文"}
              </button>
            </div>
            {skillSourceView ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-sm leading-6 text-l2">
                {shownSkillText}
              </pre>
            ) : (
              <>
                {skillDoc.fields.length > 0 && (
                  <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md ccode-well px-3 py-2 text-xs">
                    {skillDoc.fields.map((f) => (
                      <div key={f.key} className="contents">
                        <dt className="font-mono text-l4">{f.key}</dt>
                        <dd className="min-w-0 break-words text-l2">{f.value || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <div
                  className="md-body"
                  dangerouslySetInnerHTML={{ __html: skillDoc.html }}
                />
              </>
            )}
          </div>
          </div>
        </div>
      )}

      {editor && (
        <SkillEditorModal
          mode={editor.mode}
          skill={editor.mode === "edit" ? editor.skill : undefined}
          initialBody={editor.mode === "edit" ? editor.body : undefined}
          draft={editor.mode === "create" ? editor.draft : undefined}
          onClose={() => setEditor(null)}
          onDone={(msg, editedId) => {
            setNotice(msg);
            // 正在预览的技能被编辑后，面板内容同步刷新
            if (editedId && preview?.skill.id === editedId) {
              void onView(preview.skill);
            }
            void refresh();
          }}
        />
      )}
      {optimize && (
        <OptimizeModal
          skill={optimize}
          skillLib={skills}
          onClose={() => setOptimize(null)}
          onConfirm={(opinion) => confirmOptimize(optimize, opinion)}
          onCreated={async (created) => {
            // 落库即终点：刷新 + 失效行为键映射（新技能的 provides 立即可点亮流程入口）；
            // 挂步骤/分发只指路不代做——打开既有反向挂载弹层
            await refresh();
            invalidateSkillProvides();
            setNotice(`已创建「${created.name}」；挂载到步骤走 ⋯ 菜单，分发用右侧开关`);
            try {
              const content = await invoke<string>("read_skill_md", { id: created.id });
              setPreview({ skill: created, content });
            } catch {
              /* 预览失败不影响落库结果 */
            }
          }}
        />
      )}
      {adapt && (
        <AdaptModal
          skill={adapt}
          initialContent={skillAdaptJobs[adapt.id]?.content ?? null}
          initialError={skillAdaptJobs[adapt.id]?.error ?? null}
          unchanged={skillAdaptJobs[adapt.id]?.unchanged === true}
          onClose={() => setAdapt(null)}
          onRetry={() => {
            setAdapt(null);
            startSkillAdapt({ id: adapt.id, name: adapt.name }, true);
            toast(`正在重新生成「${adapt.name}」的适配稿`);
          }}
          onSaved={async () => {
            clearSkillAdapt(adapt.id);
            setNotice(`技能「${adapt.name}」已按流水线口径适配（原文件已备份）`);
            await refresh();
          }}
        />
      )}
      {bindSkill && (
        <BindToStepModal
          skill={bindSkill}
          onClose={() => setBindSkill(null)}
          onBound={(msg) => setNotice(msg)}
        />
      )}
      {deleteTarget && (
        <DeleteSkillModal
          skill={deleteTarget}
          derivedChildren={skills
            .filter((s) => s.derivedFrom?.some((d) => d.name === deleteTarget.name))
            .map((s) => s.name)}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => confirmDelete(deleteTarget)}
        />
      )}
      {modal?.kind === "import" && (
        <ImportModal
          initialGithub={modal.github}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setNotice(msg);
            void refresh();
          }}
        />
      )}
      {modal?.kind === "discover" && (
        <DiscoverModal
          items={discovered}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            setNotice(msg);
            void refresh();
          }}
        />
      )}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          onClose={() => setTopMenu(null)}
          items={[
            {
              icon: Import,
              label: "导入技能",
              onSelect: () => setModal({ kind: "import" }),
            },
            ...(skills.length
              ? [
                  {
                    icon: FileDown,
                    label: "导出全部 ZIP",
                    onSelect: () =>
                      void onExport(
                        skills.map((skill) => skill.id),
                        "ccode-skills.zip",
                      ),
                  },
                ]
              : []),
            { separator: true },
            {
              icon: FolderSearch,
              label: "发现未纳管技能",
              onSelect: () => void onDiscover(),
            },
            {
              icon: RefreshCw,
              label: checkingUpdates
                ? "正在检查 GitHub 更新…"
                : "检查 GitHub 更新",
              onSelect: () => {
                if (!checkingUpdates) void onCheckUpdates();
              },
            },
            {
              icon: Layers,
              label: "无分类 GitHub 技能按仓库归组",
              onSelect: () => void onBackfillCategories(),
            },
          ]}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              icon: Eye,
              label: "查看详情",
              onSelect: () => void onView(rowMenu.skill),
            },
            {
              icon: Pencil,
              label: "编辑内容",
              onSelect: () => void onEdit(rowMenu.skill),
            },
            { separator: true },
            {
              icon: WandSparkles,
              label: "优化",
              hint: "AI",
              onSelect: () => setOptimize(rowMenu.skill),
            },
            {
              icon: Workflow,
              label: "适配到流水线",
              hint: "AI",
              onSelect: () => openAdapt(rowMenu.skill),
            },
            {
              icon: Link,
              label: "挂载到步骤",
              onSelect: () => setBindSkill(rowMenu.skill),
            },
            { separator: true },
            {
              icon: Folder,
              label: "设置分类",
              onSelect: () =>
                setCatEdit({
                  id: rowMenu.skill.id,
                  value: rowMenu.skill.category ?? "",
                }),
            },
            {
              icon: Tag,
              label: "设置标签",
              onSelect: () =>
                setTagEdit({
                  id: rowMenu.skill.id,
                  value: (rowMenu.skill.tags ?? []).join("，"),
                }),
            },
            { separator: true },
            ...((rowMenu.skill.staleCopies ?? []).length > 0
              ? [
                  {
                    icon: RefreshCw,
                    label: "重新分发副本",
                    onSelect: () => void onResync(rowMenu.skill),
                  },
                ]
              : []),
            {
              icon: FileDown,
              label: "导出 ZIP",
              onSelect: () =>
                void onExport([rowMenu.skill.id], `${rowMenu.skill.name}.zip`),
            },
            ...(updates[rowMenu.skill.id]?.updateAvailable
              ? [
                  {
                    icon: Download,
                    label: "一键应用 GitHub 更新",
                    onSelect: () => void onApplyUpdate(rowMenu.skill),
                  },
                ]
              : []),
            ...(rowMenu.skill.repo
              ? [
                  {
                    icon: Import,
                    label: updates[rowMenu.skill.id]?.updateAvailable
                      ? "导入 GitHub 更新"
                      : "重新从 GitHub 导入",
                    onSelect: () =>
                      setModal({
                        kind: "import",
                        github: {
                          repo: rowMenu.skill.repo!,
                          branch: rowMenu.skill.repoRef ?? "",
                          subdir: rowMenu.skill.repoSubdir ?? "",
                        },
                      }),
                  },
                ]
              : []),
            {
              icon: Trash2,
              label: "删除",
              danger: true,
              onSelect: () => setDeleteTarget(rowMenu.skill),
            },
          ]}
        />
      )}
    </div>
  );
}
