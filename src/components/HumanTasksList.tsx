import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, InlineNotice } from "./PageFrame";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
  HumanTaskStateDto,
  ImportDeliverableDto,
  ProjectConfigDto,
} from "../types";
import { stripOptionalTitlePrefix } from "../step-flow";

/** 检索结果导入的固定落点（lit-search 人肉中转协议：agent 开工自动解析、去重、合并进筛选清单） */
export const SEARCH_IMPORTS_DIR = "papers/imports/";

/** 扩展名 → 资源类型（与后端 classify_extension 同一口径：paper/dataset/reference/other） */
function resourceTypeOf(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "paper";
  if (["csv", "tsv", "parquet", "xlsx", "sav", "dta"].includes(ext))
    return "dataset";
  if (["bib", "ris", "enw"].includes(ext)) return "reference";
  return "other";
}

/** 人工事项的状态与动作（HumanTasksList 平铺清单与 StepFlow 流程线共用）：
 *  状态全部后端派生（落点检测 + 手动勾选，手动优先），挂载时取一次、操作后重取，不轮询。
 *  提交交付 = 系统对话框选文件 或 把文件拖到条目上（webview 窗口级 drag-drop 事件，
 *  落点判定用 elementFromPoint 命中带 data-human-task 的行元素；取不到命中时静默忽略）。
 *  containerRef 指向包裹所有 [data-human-task] 行的容器（ul/div 均可） */
export function useHumanTasks({
  projectPath,
  stepName,
  containerRef,
  onChanged,
  onStates,
}: {
  projectPath: string;
  stepName: string;
  containerRef: React.RefObject<HTMLElement | null>;
  onChanged?: () => void;
  onStates?: (states: HumanTaskStateDto[]) => void;
}) {
  const [states, setStates] = useState<HumanTaskStateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyTitle, setBusyTitle] = useState<string | null>(null);
  // 拖拽悬停命中的事项标题（高亮行）
  const [dropHover, setDropHover] = useState<string | null>(null);
  // 导入成功后的「登记为项目资源」追问（7b）：仅交付落在项目根时出现，关掉不纠缠。
  // 检索结果多选导入时一次攒齐再问一次，不逐个弹（destRels 保序去重）
  const [registerOffer, setRegisterOffer] = useState<{
    destRels: string[];
  } | null>(null);

  async function reload() {
    try {
      const all = await invoke<HumanTaskStateDto[]>("list_human_task_states", {
        projectRoot: projectPath,
      });
      const mine = all.filter((s) => s.step === stepName);
      setStates(mine);
      onStates?.(mine);
    } catch {
      /* 读取失败静默：下轮挂载/操作重试 */
    }
  }

  useEffect(() => {
    let stale = false;
    invoke<HumanTaskStateDto[]>("list_human_task_states", {
      projectRoot: projectPath,
    })
      .then((all) => {
        if (stale) return;
        const mine = all.filter((s) => s.step === stepName);
        setStates(mine);
        onStates?.(mine);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, stepName]);

  // 窗口级文件拖放：命中本清单某行 = 提交该事项的交付物
  useEffect(() => {
    if (!states?.some((s) => s.target)) return;
    /** Tauri drag-drop 位置为物理像素，elementFromPoint 要 CSS 像素：两种都试 */
    function hitRow(x: number, y: number): HTMLElement | null {
      const scale = window.devicePixelRatio || 1;
      for (const [cx, cy] of [
        [x, y],
        [x / scale, y / scale],
      ]) {
        const el = document.elementFromPoint(cx, cy);
        const row = el?.closest<HTMLElement>("[data-human-task]");
        if (row && containerRef.current?.contains(row)) return row;
      }
      return null;
    }
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        const row = hitRow(event.payload.position.x, event.payload.position.y);
        setDropHover(row?.dataset.humanTask ?? null);
      } else if (event.payload.type === "drop") {
        const row = hitRow(event.payload.position.x, event.payload.position.y);
        setDropHover(null);
        const title = row?.dataset.humanTask;
        const path = event.payload.paths[0];
        if (title && path) void importFile(title, path);
      } else {
        setDropHover(null);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states, projectPath, stepName]);

  async function toggle(task: HumanTaskStateDto, checked: boolean) {
    setError(null);
    try {
      await invoke("set_human_task_check", {
        projectRoot: projectPath,
        step: stepName,
        title: task.title,
        checked,
      });
      await reload();
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 待确认篇目全部纳入或排除后勾上「核对待确认篇目」。
   *  人手取消过的不覆盖。失败交给流程线已有错误行。 */
  async function checkPendingConfirmIfOpen(title: string) {
    const task = states?.find((row) => row.step === stepName && row.title === title);
    if (!task || task.done || task.explicitCancel) return;
    await toggle(task, true);
  }

  /** 学术检索 MCP 已添加且已登录时勾上。人手取消过的不覆盖。 */
  async function checkAcademicMcpIfReady(title: string) {
    const task = states?.find((row) => row.step === stepName && row.title === title);
    if (!task || task.done || task.explicitCancel) return;
    await toggle(task, true);
  }

  /** 落点是否就是项目根（工作区是临时的，登记其中路径没意义） */
  function landedInProjectRoot(out: ImportDeliverableDto): boolean {
    const norm = (p: string) => p.replace(/[\\/]+$/, "");
    return norm(out.destRoot) === norm(projectPath);
  }

  /** 提交产物（按钮选文件 / 拖拽共用）：复制进落点 + 登记提货单（登记失败只提示不否决）。
   *  targetOverride = 落点覆盖（papers/imports/ 检索结果导入专用）：提示文案不同，
   *  且「登记为项目资源」由调用方在多选全部导完后统一追问，本函数不逐个弹。
   *  返回后端结果供调用方聚合；失败返回 null */
  async function importFile(
    title: string,
    sourcePath: string,
    targetOverride?: string,
  ): Promise<ImportDeliverableDto | null> {
    setBusyTitle(title);
    setError(null);
    setNote(null);
    setRegisterOffer(null);
    try {
      const out = await invoke<ImportDeliverableDto>("import_human_deliverable", {
        projectRoot: projectPath,
        step: stepName,
        title,
        sourcePath,
        targetOverride: targetOverride ?? null,
      });
      if (targetOverride) {
        setNote(
          `已放入 ${targetOverride.replace(/[\\/]+$/, "")}/，agent 开工时会自动解析、去重并合并进筛选清单`,
        );
      } else {
        setNote(
          out.registered
            ? `已提交「${title}」→ ${out.destRel}（已登记提货单）`
            : `已提交「${title}」→ ${out.destRel}（提货单登记未成功：${out.registerError ?? "未知原因"}）`,
        );
        if (landedInProjectRoot(out)) setRegisterOffer({ destRels: [out.destRel] });
      }
      await reload();
      onChanged?.();
      return out;
    } catch (reason) {
      setError(String(reason));
      return null;
    } finally {
      setBusyTitle(null);
    }
  }

  async function pickFile(title: string) {
    const selected = await open({
      multiple: false,
      directory: false,
      title: `选择「${title}」的交付文件`,
    });
    if (typeof selected === "string") void importFile(title, selected);
  }

  /** 导入检索结果（papers/ 落点事项的专用入口）：多选 Undermind/Consensus/Elicit 等
   *  闭源站导出的 RIS/BibTeX/CSV，落点固定 papers/imports/（lit-search 协议） */
  async function pickSearchResults(title: string) {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择导出的检索结果文件",
      filters: [
        {
          name: "检索结果（RIS / BibTeX / CSV / TXT）",
          extensions: ["ris", "bib", "csv", "txt"],
        },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (paths.length === 0) return;
    // 逐个导入：单个失败（如同名已存在）不阻断其余，失败数最后统一回报
    const landed: string[] = [];
    let failed = 0;
    for (const p of paths) {
      const out = await importFile(title, p, SEARCH_IMPORTS_DIR);
      if (!out) {
        failed += 1;
        continue;
      }
      if (landedInProjectRoot(out) && !landed.includes(out.destRel))
        landed.push(out.destRel);
    }
    const dir = SEARCH_IMPORTS_DIR.replace(/[\\/]+$/, "");
    const ok = paths.length - failed;
    setError(
      failed > 0 ? `${failed} 个文件没导进来（多为落点已存在同名文件）` : null,
    );
    setNote(
      ok > 0
        ? `已放入 ${dir}/（${ok} 份），agent 开工时会自动解析、去重并合并进筛选清单`
        : null,
    );
    // 落在项目根的题录登记为项目资源后，TASK.md 的「项目资源」段会按绝对路径列出，
    // agent 在工作树里也读得到——工作区不含主仓未提交的文件
    if (landed.length > 0) setRegisterOffer({ destRels: landed });
  }

  /** 登记导入的交付文件为项目资源（读-改-写回 project.toml，与资源面板同一口径）：
   *  同路径已登记的跳过，不产生重复行 */
  async function registerOffered() {
    if (!registerOffer) return;
    setError(null);
    try {
      const read = await invoke<{ config: ProjectConfigDto }>(
        "read_project_config",
        { path: projectPath },
      );
      const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
      const known = new Set(read.config.resources.map((r) => norm(r.path)));
      const added = registerOffer.destRels
        .filter((rel) => !known.has(norm(rel)))
        .map((rel) => ({
          name: rel.split("/").pop() ?? rel,
          path: rel,
          type: resourceTypeOf(rel),
          readonly: false,
          note: "",
        }));
      if (added.length > 0) {
        await invoke("write_project_config", {
          path: projectPath,
          config: {
            ...read.config,
            resources: [...read.config.resources, ...added],
          },
        });
      }
      setNote(
        added.length === 0
          ? "这些文件已经登记过了"
          : added.length === 1
            ? `已登记为项目资源：${added[0].path}`
            : `已登记 ${added.length} 个文件为项目资源`,
      );
      setRegisterOffer(null);
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    checkPendingConfirmIfOpen,
    checkAcademicMcpIfReady,
    pickFile,
    pickSearchResults,
    registerOffer,
    registerOffered,
    dismissRegisterOffer: () => setRegisterOffer(null),
  };
}

/** 「登记为项目资源」追问页脚（平铺清单与流程线共用，避免两份文案各自漂移）：
 *  长路径截断不挤走按钮；多文件只报数量，全量路径进 tooltip */
export function RegisterOfferRow({
  destRels,
  onRegister,
  onDismiss,
  className = "",
}: {
  destRels: string[];
  onRegister: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <p
      className={`mt-1 flex items-center gap-1.5 text-micro text-l3 ${className}`}
    >
      <span className="min-w-0 truncate" title={destRels.join("\n")}>
        要登记为项目资源吗（
        {destRels.length === 1 ? destRels[0] : `${destRels.length} 个文件`}）
      </span>
      <button
        type="button"
        onClick={onRegister}
        title="登记后 TASK.md 的「项目资源」段会按绝对路径列出，agent 在工作区里也读得到"
        className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
      >
        登记
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="不登记，文件已在落点目录里"
        className="shrink-0 rounded-sm px-1 py-0.5 text-l4 hover:bg-hover hover:text-l1"
      >
        不了
      </button>
    </p>
  );
}

/** 人工事项平铺 checklist（开工确认弹层用；聚焦视图用 StepFlow 流程线）：
 *  状态与动作逻辑在 useHumanTasks，本组件只是分组渲染。
 *  收尾（after）事项不在这里出现——那是 agent 干完才轮到人做的活，开工时摆出来只会让人
 *  误以为现在就要做；收尾语境由 StepFlow 流程线节点与评审「收尾事项」行承担 */
export default function HumanTasksList({
  projectPath,
  stepName,
  onChanged,
  onStates,
  compact = false,
}: {
  projectPath: string;
  stepName: string;
  /** 勾选/交付后通知父级（外部统计重取） */
  onChanged?: () => void;
  /** 每次状态（重）载后回传本步骤的状态切片（开工弹层的开工前提醒等需要读状态） */
  onStates?: (states: HumanTaskStateDto[]) => void;
  /** 开工弹层：可选事项不算「待做」，单组时不写「开始前」 */
  compact?: boolean;
}) {
  // 拖拽落点容器：必须包住全部三个时机分组的行——挂在分组内的 <ul> 上会被后一组覆盖，
  // 只剩最后一组能命中（useHumanTasks 的 containerRef.contains 判定）
  const listRef = useRef<HTMLDivElement>(null);
  const {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    pickFile,
    registerOffer,
    registerOffered,
    dismissRegisterOffer,
  } = useHumanTasks({
    projectPath,
    stepName,
    containerRef: listRef,
    onChanged,
    onStates,
  });

  if (states !== null && states.length === 0) return null;

  // 收尾（after）事项整组不显示（见组件头注释）；「N 件待做」与空态判断同口径
  const visible = states?.filter((s) => s.timing !== "after") ?? null;
  if (visible !== null && visible.length === 0) return null;

  const pendingRequired =
    visible?.filter((s) => !s.done && !s.optional).length ?? 0;
  const timingGroups = (["before", "during"] as const).filter((timing) =>
    (visible ?? []).some((s) =>
      timing === "during"
        ? s.timing !== "before" && s.timing !== "after"
        : s.timing === timing,
    ),
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-micro text-l4">
          {compact && pendingRequired === 0 ? "可选准备" : "人工事项"}
        </span>
        {pendingRequired > 0 && (
          <span className="text-micro text-warn-text">
            {pendingRequired} 件待做
          </span>
        )}
      </div>
      {visible === null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        // 按时机分组（开始前 → 进行中）：组名即"什么时候轮到你了"，
        // 避免不同档的事项并排摆着被误读成"现在全都要做"
        <div ref={listRef} className="space-y-2">
          {(["before", "during"] as const)
            .map((timing) => ({
              timing,
              items: visible.filter((s) =>
                timing === "during"
                  ? s.timing !== "before" && s.timing !== "after"
                  : s.timing === timing,
              ),
            }))
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.timing}>
                {!(compact && timingGroups.length <= 1) && (
                <div className="mb-0.5 text-micro text-l4">
                  {g.timing === "before"
                    ? "开始前"
                    : "进行中"}
                </div>
                )}
                <ul className="space-y-1">
                  {g.items.map((task) => (
            <li
              key={task.title}
              data-human-task={task.target ? task.title : undefined}
              className={`rounded-sm px-1.5 py-1 ${
                dropHover === task.title
                  ? "bg-cta/10 outline outline-1 outline-cta-bd"
                  : "ccode-well"
              }`}
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  className="shrink-0"
                  checked={task.done}
                  disabled={busyTitle === task.title}
                  onChange={(checked) => void toggle(task, checked)}
                  title={
                    task.completion === "manual"
                      ? task.manual
                        ? "人工已确认；取消勾选回到待确认"
                        : "必须由你明确确认完成"
                      : task.detected && !task.manual
                      ? "落点已检测到文件；取消勾选会保留为未完成，需重新勾选确认"
                      : task.manual
                        ? "人工已确认；取消勾选会保留为未完成"
                        : "勾选 = 人工确认完成（系统不再追问）"
                  }
                />
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${
                    task.done ? "text-l3 line-through" : "text-l1"
                  }`}
                >
                  {task.optional
                    ? stripOptionalTitlePrefix(task.title)
                    : task.title}
                </span>
                {task.done && (
                  <span className="shrink-0 text-micro text-done">
                    {task.manual
                      ? "已确认"
                      : task.completion === "all"
                        ? `全部目标已满足${task.expectedCount != null ? `（清单共 ${task.expectedCount} 篇）` : ""}`
                        : task.completion === "no_placeholders"
                          ? "已清除占位"
                          : task.completion === "decisions_cleared"
                            ? "已逐条裁决"
                      : task.hitCount != null
                        ? `已见到 ${task.hitCount} 个文件${task.expectedCount != null ? `（清单共 ${task.expectedCount} 篇）` : ""}`
                        : "已见到文件"}
                  </span>
                )}
                {/* 显式取消后检测仍命中的计数也亮出来：进度感不该跟着勾态消失 */}
                {!task.done && !task.manual && task.hitCount != null && (
                  <span className="shrink-0 text-micro text-l4">
                    落点已有 {task.hitCount} 个文件
                    {task.expectedCount != null
                      ? `（清单共 ${task.expectedCount} 篇）`
                      : ""}
                  </span>
                )}
                {task.target && !task.done && (
                  <button
                    type="button"
                    disabled={busyTitle !== null}
                    onClick={() => void pickFile(task.title)}
                    title={`选文件提交到落点 ${task.target}（复制 + 登记提货单）；也可直接把文件拖到这一行`}
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    {busyTitle === task.title ? "提交中…" : "提交产物"}
                  </button>
                )}
              </div>
              {(task.guidance || task.target) && (
                <details className="mt-0.5 pl-6">
                  <summary className="cursor-pointer select-none text-micro text-l4 hover:text-l2">
                    怎么做 / 落点
                  </summary>
                  <div className="mt-0.5 space-y-0.5 text-micro leading-4 text-l3">
                    {task.guidance && (
                      <p className="whitespace-pre-wrap">{task.guidance}</p>
                    )}
                    {task.target && (
                      <p className="font-mono text-l4">
                        落点：{task.target}（放到这里系统会自动勾上）
                      </p>
                    )}
                  </div>
                </details>
              )}
            </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
      {note && <InlineNotice tone="ok" size="micro" className="mt-1">{note}</InlineNotice>}
      {registerOffer && (
        <RegisterOfferRow
          destRels={registerOffer.destRels}
          onRegister={() => void registerOffered()}
          onDismiss={dismissRegisterOffer}
        />
      )}
      {error && <InlineNotice tone="err" size="micro" className="mt-1">{error}</InlineNotice>}
    </div>
  );
}
