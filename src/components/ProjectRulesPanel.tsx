import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { File, FileText, Folder, Plus, Search, X } from "lucide-react";
import {
  effectiveProjectRules,
  isSettingPlaceholder,
  projectShowsProtectedPaths,
  projectUsesSkillPool,
  settingParts,
  uniqueRuleLines,
} from "../project-context";
import {
  pathIsProtected,
  protectableEntries,
  relativeProjectPath,
  suggestProtectedPaths,
  toggleProtectedFolder,
  type ProtectEntry,
} from "../project-tasks";
import { normalizeWorkMode } from "../work-mode";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import type { DirEntryDto } from "./FileTree";
import type { ProjectConfigDto, ProjectConfigReadDto, SkillDto } from "../types";
import {
  Checkbox,
  FoldMark,
  compactFieldClass,
  ghostActionClass,
  iconActionClass,
  searchFieldClass,
  secondaryActionClass,
  surfaceFieldClass,
} from "./PageFrame";

const RULE_PLACEHOLDER: Record<string, string> = {
  research: "引用格式：APA\n输出中文",
  office: "按公司模板写\n语气正式",
  coding: "只改当前工作树\n不要切回主仓改",
};

const TOOL_SETTING_PREFIX = "科研工具/";

type PlaceholderSlot = {
  key: string;
  hint: string;
  value: string;
};

function splitSettingsForEditor(lines: readonly string[]): {
  toolLines: string[];
  slots: PlaceholderSlot[];
  freeLines: string[];
} {
  const toolLines: string[] = [];
  const slots: PlaceholderSlot[] = [];
  const freeLines: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(TOOL_SETTING_PREFIX)) {
      toolLines.push(line);
      continue;
    }
    if (isSettingPlaceholder(line)) {
      const { q, answer } = settingParts(line);
      slots.push({
        key: q,
        hint: answer || "（待填）",
        value: "",
      });
      continue;
    }
    freeLines.push(line);
  }
  return { toolLines, slots, freeLines };
}

function mergeSettingsFromEditor(
  toolLines: readonly string[],
  slots: readonly PlaceholderSlot[],
  freeText: string,
): string[] {
  const slotLines = slots.map((slot) => {
    const trimmed = slot.value.trim();
    return trimmed ? `${slot.key}：${trimmed}` : `${slot.key}：${slot.hint}`;
  });
  const freeLines = freeText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return uniqueRuleLines([...slotLines, ...freeLines, ...toolLines]);
}

export default function ProjectRulesPanel({
  projectPath,
  workMode,
  compact = false,
  defaultOpen = false,
  onPreviewFile,
  onSaved,
  onError,
}: {
  projectPath: string;
  workMode?: string | null;
  compact?: boolean;
  defaultOpen?: boolean;
  onPreviewFile?: (relPath: string) => void;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const mode = normalizeWorkMode(workMode);
  const [open, setOpen] = useState(defaultOpen);
  const [config, setConfig] = useState<ProjectConfigDto | null>(null);
  const [toolLines, setToolLines] = useState<string[]>([]);
  const [slots, setSlots] = useState<PlaceholderSlot[]>([]);
  const [rulesDraft, setRulesDraft] = useState("");
  const [repoDocs, setRepoDocs] = useState<string[]>([]);
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [entries, setEntries] = useState<ProtectEntry[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protectOpen, setProtectOpen] = useState(false);
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [librarySkills, setLibrarySkills] = useState<SkillDto[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const addSkillRef = useRef<HTMLButtonElement>(null);
  const rulesRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    let nextProtected: string[] = [];
    let listed: ProjectConfigDto | null = null;
    try {
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      listed = read.config;
      setConfig(read.config);
      const savedLines = uniqueRuleLines(read.config.settings ?? []);
      const effective = savedLines.length
        ? savedLines
        : effectiveProjectRules(
            read.config.settings,
            workMode ?? read.config.workMode,
            read.config.rulesOwned,
          );
      const split = splitSettingsForEditor(effective);
      setToolLines(split.toolLines);
      setSlots(split.slots);
      setRulesDraft(split.freeLines.join("\n"));
      nextProtected = read.config.protectedPaths ?? [];
      setProtectedPaths(nextProtected);
      const projectSkills = read.config.skills ?? [];
      setSkillNames(projectSkills);
      setError(null);
    } catch (reason) {
      const message = `读取项目规则失败：${String(reason)}`;
      setError(message);
      onError?.(message);
    }
    const protect =
      listed != null &&
      projectShowsProtectedPaths(
        workMode ?? listed.workMode,
        listed.steps.length,
      );
    try {
      const top = await invoke<DirEntryDto[]>("list_dir", {
        path: projectPath,
        showHidden: false,
      });
      const docs = top
        .filter((entry) => !entry.isDir && /^(AGENTS|CLAUDE)\.md$/i.test(entry.name))
        .map((entry) => entry.name);
      setRepoDocs(docs);
      setEntries(protect ? protectableEntries(top, nextProtected, workMode) : []);
    } catch {
      setRepoDocs([]);
      setEntries(protect ? protectableEntries([], nextProtected, workMode) : []);
    }
  }, [onError, projectPath, workMode]);

  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((skills) => {
        if (!stale) setLibrarySkills(skills);
      })
      .catch(() => {
        if (!stale) setSkillsError(true);
      })
      .finally(() => {
        if (!stale) setSkillsLoading(false);
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const el = rulesRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 200)}px`;
  }, [open, rulesDraft]);

  async function save(
    nextSlots: readonly PlaceholderSlot[],
    nextRules: string,
    nextProtected: string[],
    nextSkills: string[],
  ) {
    if (!config) return;
    try {
      const latest = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: projectPath,
      });
      const latestTools = (latest.config.settings ?? []).filter((line) =>
        line.trim().startsWith(TOOL_SETTING_PREFIX),
      );
      const rules = mergeSettingsFromEditor(
        latestTools.length ? latestTools : toolLines,
        nextSlots,
        nextRules,
      );
      await invoke("write_project_config", {
        path: projectPath,
        config: {
          ...latest.config,
          settings: rules,
          rulesOwned: true,
          protectedPaths: nextProtected,
          skills: nextSkills,
        },
      });
      setConfig({
        ...latest.config,
        settings: rules,
        rulesOwned: true,
        protectedPaths: nextProtected,
        skills: nextSkills,
      });
      setProtectedPaths(nextProtected);
      setSkillNames(nextSkills);
      setError(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    } catch (reason) {
      const message = `保存项目规则失败：${String(reason)}`;
      setError(message);
      onError?.(message);
    }
  }

  function toggleFolder(path: string, checked: boolean) {
    const next = toggleProtectedFolder(protectedPaths, path, checked);
    setProtectedPaths(next);
    void save(slots, rulesDraft, next, skillNames);
  }

  function toggleSkill(name: string, checked: boolean) {
    const next = checked
      ? [...skillNames, name]
      : skillNames.filter((item) => item !== name);
    setSkillNames(next);
    void save(slots, rulesDraft, protectedPaths, next);
  }

  function updateSlotValue(index: number, value: string) {
    setSlots((current) =>
      current.map((slot, idx) => (idx === index ? { ...slot, value } : slot)),
    );
  }

  const freeRuleCount = rulesDraft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
  const filledSlotCount = slots.filter((s) => s.value.trim().length > 0).length;
  const pendingSlotCount = slots.length - filledSlotCount;
  const ruleCount = freeRuleCount + filledSlotCount;
  const showProtect =
    config != null && projectShowsProtectedPaths(mode, config.steps.length);
  const showSkillPool =
    config != null && projectUsesSkillPool(mode, config.steps.length);
  const suggested = new Set(
    suggestProtectedPaths(
      mode,
      entries.filter((entry) => entry.isDir).map((entry) => entry.path),
    ),
  );
  const folders = entries.filter((entry) => entry.isDir);
  const files = entries.filter((entry) => !entry.isDir);
  const featuredFolders = folders.filter(
    (entry) => suggested.has(entry.path) || pathIsProtected(entry.path, protectedPaths),
  );
  const showAllProtectFolders = showAllFolders || suggested.size === 0;
  const visibleFolders = showAllProtectFolders ? folders : featuredFolders;
  const extraFolders = showAllProtectFolders
    ? []
    : folders.filter(
        (entry) => !visibleFolders.some((item) => item.path === entry.path),
      );
  const protectedFiles = protectedPaths
    .filter((path) => !folders.some((entry) => samePath(entry.path, path, IS_WINDOWS)))
    .map((path) => ({ path, isDir: false }));
  const addableSkills = librarySkills.filter((skill) => !skillNames.includes(skill.name));
  const query = skillQuery.trim().toLowerCase();
  const matchingSkills = addableSkills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query),
  );

  function closeSkillPicker() {
    setSkillPickerOpen(false);
    setSkillQuery("");
    addSkillRef.current?.focus();
  }
  const summary = [
    ruleCount ? `${ruleCount} 条` : "默认",
    pendingSlotCount > 0 ? `${pendingSlotCount} 项待填` : null,
    repoDocs.length > 0 ? repoDocs.join("/") : null,
    showProtect && protectedPaths.length ? `⊘${protectedPaths.length}` : null,
    showSkillPool && skillNames.length ? `✦${skillNames.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  function renderProtectRow(entry: ProtectEntry) {
    const checked = pathIsProtected(entry.path, protectedPaths);
    return (
      <li key={entry.path} className="min-w-0">
        <Checkbox
          className={`min-h-9 min-w-0 rounded-md px-2 py-1.5 transition-colors focus-within:outline focus-within:outline-1 focus-within:outline-l3 ${checked ? "bg-hover" : "hover:bg-hover"}`}
          checked={checked}
          title={entry.isDir ? `${entry.path}/` : entry.path}
          label={
            <span className="flex min-w-0 items-center gap-2 text-xs text-l2">
              {entry.isDir ? (
                <Folder size={14} className="shrink-0 text-l3" aria-hidden="true" />
              ) : (
                <File size={14} className="shrink-0 text-l3" aria-hidden="true" />
              )}
              <span className="truncate">{entry.path}{entry.isDir ? "/" : ""}</span>
            </span>
          }
          onChange={(next) => toggleFolder(entry.path, next)}
        />
      </li>
    );
  }

  return (
    <section className={compact ? "" : "space-y-3"}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        <span className="text-xs font-medium text-l3">规则</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">{summary}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {repoDocs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md ccode-well px-2.5 py-1.5 text-micro text-l3">
              <FileText size={12.5} className="shrink-0 text-l4" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                检测到仓库自带 {repoDocs.join(" / ")}（CLI 启动自动读取），下方可写 Mesa 补充规则
              </span>
              {onPreviewFile &&
                repoDocs.map((docName) => (
                  <button
                    key={docName}
                    type="button"
                    className={ghostActionClass}
                    onClick={() => onPreviewFile(docName)}
                  >
                    查看 {docName}
                  </button>
                ))}
            </div>
          )}
          {slots.length > 0 && (
            <div className="space-y-1.5 rounded-md ccode-well p-2.5" aria-label="待填规则项">
              <p className="text-micro text-l3">
                待定设定（直接填写即可，也可在步骤上点「跟 AI 商量一下」确定）：
              </p>
              {slots.map((slot, index) => (
                <label key={slot.key} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate text-l2" title={slot.key}>
                    {slot.key}
                  </span>
                  <input
                    className={`${compactFieldClass} min-w-0 flex-1`}
                    value={slot.value}
                    placeholder={slot.hint.replace(/^[（(]|[）)]$/g, "")}
                    aria-label={`设定项 ${slot.key}`}
                    onChange={(event) => updateSlotValue(index, event.target.value)}
                    onBlur={() => void save(slots, rulesDraft, protectedPaths, skillNames)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        (event.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          <textarea
            ref={rulesRef}
            className={`${surfaceFieldClass} resize-none overflow-hidden leading-6`}
            value={rulesDraft}
            onChange={(event) => setRulesDraft(event.target.value)}
            onBlur={() => void save(slots, rulesDraft, protectedPaths, skillNames)}
            placeholder={RULE_PLACEHOLDER[mode]}
            aria-label="项目规则"
          />
          {mode === "research" && (config?.steps.length ?? 0) > 0 && (
            <p className="text-micro text-l4">
              当前使用研究流程：各步骤的能力挂载与验收口径随步骤单独配置。
            </p>
          )}
          {showProtect && (
            <div className="pt-2">
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-1.5 text-left"
                onClick={() => setProtectOpen((current) => !current)}
                aria-expanded={protectOpen}
              >
                <FoldMark open={protectOpen} />
                <span className="flex-1 text-xs font-medium text-l2">写回时跳过</span>
                <span className="text-micro text-l3">
                  {protectedPaths.length ? `已选 ${protectedPaths.length} 项` : "未设置"}
                </span>
              </button>
              {protectOpen && (
                <div className="mt-1 space-y-2">
                  <p className="text-xs text-l3">勾选项在验收写回时保持原样。</p>
                  {folders.length === 0 && files.length === 0 && protectedFiles.length === 0 ? (
                    <p className="rounded-md ccode-well px-3 py-3 text-xs text-l3">
                      项目里还没有可勾选的文件或文件夹。
                    </p>
                  ) : (
                    <>
                      {visibleFolders.length > 0 && (
                        <ul
                          aria-label="写回时跳过的文件夹"
                          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-1 rounded-lg ccode-well p-1"
                        >
                          {visibleFolders.map(renderProtectRow)}
                        </ul>
                      )}
                      {protectedFiles.length > 0 && (
                        <ul aria-label="写回时跳过的文件" className="space-y-1 rounded-lg ccode-well p-1">
                          {protectedFiles.map(renderProtectRow)}
                        </ul>
                      )}
                    </>
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      className={`${ghostActionClass} gap-1.5`}
                      onClick={() => {
                        void (async () => {
                          const picked = await openFileDialog({
                            multiple: true,
                            directory: false,
                            defaultPath: projectPath,
                          });
                          if (!picked) return;
                          const list = Array.isArray(picked) ? picked : [picked];
                          const next = [...protectedPaths];
                          for (const abs of list) {
                            const rel = relativeProjectPath(projectPath, abs);
                            if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) continue;
                            if (!pathIsProtected(rel, next)) next.push(rel);
                          }
                          if (next.length !== protectedPaths.length) {
                            setProtectedPaths(next);
                            void save(slots, rulesDraft, next, skillNames);
                          }
                        })();
                      }}
                    >
                      <Plus size={14} aria-hidden="true" />
                      添加文件
                    </button>
                    {extraFolders.length > 0 && (
                      <button
                        type="button"
                        className={ghostActionClass}
                        onClick={() => setShowAllFolders(true)}
                      >
                        显示其余 {extraFolders.length} 个文件夹
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {showSkillPool && (
            <div className="pt-2">
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-1.5 text-left"
                onClick={() => setSkillsOpen((current) => !current)}
                aria-expanded={skillsOpen}
              >
                <FoldMark open={skillsOpen} />
                <span className="flex-1 text-xs font-medium text-l2">技能</span>
                <span className="text-micro text-l3">
                  {skillNames.length ? `已添加 ${skillNames.length} 个` : "未添加"}
                </span>
              </button>
              {skillsOpen && (
                <div className="mt-1 space-y-2">
                  {skillNames.length > 0 && (
                    <ul aria-label="已添加的技能" className="flex flex-wrap gap-1.5">
                      {skillNames.map((name) => (
                        <li
                          key={name}
                          className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-md bg-inset pl-2.5 pr-0.5 text-xs text-l2"
                        >
                          <span className="min-w-0 truncate" title={name}>{name}</span>
                          <button
                            type="button"
                            className={`${iconActionClass} hover:text-err-text`}
                            aria-label={`移出 ${name}`}
                            title="从项目移出，不删除技能"
                            onClick={() => toggleSkill(name, false)}
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {skillsLoading ? (
                    <p role="status" className="text-xs text-l3">正在读取技能库…</p>
                  ) : skillsError ? (
                    <p role="alert" className="text-xs text-err-text">读取技能库失败，请重新打开项目设置。</p>
                  ) : librarySkills.length === 0 ? (
                    <p className="text-xs text-l3">技能库为空，先到技能页新建或导入。</p>
                  ) : (
                    <>
                      <button
                        ref={addSkillRef}
                        type="button"
                        className={`${secondaryActionClass} w-full gap-1.5`}
                        disabled={addableSkills.length === 0}
                        aria-expanded={skillPickerOpen && addableSkills.length > 0}
                        onClick={() => {
                          setSkillPickerOpen((current) => !current);
                          setSkillQuery("");
                        }}
                      >
                        <Plus size={14} aria-hidden="true" />
                        {addableSkills.length === 0 ? "技能库中的技能已全部添加" : "从技能库添加"}
                      </button>
                      {skillPickerOpen && addableSkills.length > 0 && (
                        <div
                          className="space-y-1 rounded-lg ccode-well p-1.5"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              closeSkillPicker();
                            }
                          }}
                        >
                          <div className="relative">
                            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-l3" aria-hidden="true" />
                            <input
                              autoFocus
                              type="search"
                              aria-label="搜索项目技能"
                              placeholder="搜索名称或描述…"
                              className={`${searchFieldClass} w-full pl-8`}
                              value={skillQuery}
                              onChange={(event) => setSkillQuery(event.target.value)}
                            />
                          </div>
                          {matchingSkills.length > 0 ? (
                            <ul aria-label="可添加的技能" className="max-h-60 space-y-0.5 overflow-y-auto overscroll-contain">
                              {matchingSkills.map((skill) => (
                                <li key={skill.id}>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover focus-visible:bg-hover"
                                    aria-label={`添加技能 ${skill.name}`}
                                    title={skill.description || skill.name}
                                    onClick={() => {
                                      toggleSkill(skill.name, true);
                                      closeSkillPicker();
                                    }}
                                  >
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-xs font-medium text-l1">{skill.name}</span>
                                      {skill.description && (
                                        <span className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-l3">{skill.description}</span>
                                      )}
                                    </span>
                                    <Plus size={14} className="shrink-0 text-l3" aria-hidden="true" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p role="status" className="px-2.5 py-4 text-center text-xs text-l3">没有找到匹配的技能</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 text-micro">
            {saved && <span className="text-ok-text">✓ 已保存</span>}
            {error && <span className="text-err-text">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
