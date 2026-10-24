import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw } from "lucide-react";
import {
  DEFAULT_SESSION_TEMPLATE,
  SESSION_TEMPLATE_VARS,
  isSessionTemplateKey,
  normalizeSessionInjectionMode,
  type SessionInjectionMode,
} from "../project-context";
import { loadProjectContextPack, loadSessionTemplateValues } from "../project-context-load";
import type { ProjectConfigReadDto } from "../types";
import { confirmDialog } from "./ConfirmDialog";
import SessionTemplateEditor from "./SessionTemplateEditor";
import {
  FoldMark,
  SegTabs,
  ghostActionClass,
  surfaceFieldClass,
} from "./PageFrame";

const MODE_LABEL: Record<SessionInjectionMode, string> = {
  auto: "自动",
  custom: "自定义",
  off: "不附带",
};

/** 项目说明（原名「对话注入」，2026-10-16 拍板；2026-10-24 改名，与聊天里折起的「已附项目说明」同一个词）：
 *  在这个项目里开对话时附在第一句前面的那段说明，按项目三态可配。
 *  自动 = 现状生成；自定义 = 占位符模板（开对话按项目当时数据填入）；不附带 = 只发用户输入。
 *  开工任务书 / 验收后写入 / 编程车道目标的目标包不受这里控制。
 *  2026-10-17 收口：切到自定义时模板为空就先填默认版式（空模板会静默按自动走，选了等于没选）；
 *  预览按面板里还没保存的档位/模板渲染（所见即所得，不必先失焦保存）。 */
export default function ProjectInjectionPanel({
  projectPath,
  projectName,
  workMode,
  compact = false,
  defaultOpen = false,
  onSaved,
  onError,
}: {
  projectPath: string;
  projectName: string;
  workMode?: string | null;
  compact?: boolean;
  defaultOpen?: boolean;
  onSaved?: () => void;
  onError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<SessionInjectionMode>("auto");
  const [templateDraft, setTemplateDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // 自定义默认勾选编辑；「编辑源文本」切到原文文本框（调整顺序、逐字控制版式时用）
  const [rawMode, setRawMode] = useState(false);
  // 勾选标签的悬浮摘要：每个占位符在这个项目此刻的内容
  const [sectionValues, setSectionValues] = useState<Record<string, string> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 预览并发守卫：编辑触发的重读与手动 ↻/展开可能在飞两路，后到的旧读必须丢弃
  const previewSeqRef = useRef(0);
  // 初始读档防覆盖：用户已改过档位/模板后，迟到的挂载读档不再把表单重置回旧盘值
  const touchedRef = useRef(false);

  const loadPreview = useCallback(
    async (nextMode: SessionInjectionMode, nextTemplate: string) => {
      const seq = ++previewSeqRef.current;
      setPreviewLoading(true);
      try {
        const value = await loadProjectContextPack({
          name: projectName,
          path: projectPath,
          workMode,
          kind: "session",
          sessionOverride: { mode: nextMode, template: nextTemplate },
        });
        if (seq !== previewSeqRef.current) return;
        setPreview(value);
        setError(null);
      } catch (reason) {
        if (seq !== previewSeqRef.current) return;
        setPreview(null);
        const message = `读取注入预览失败：${String(reason)}`;
        setError(message);
        onError?.(message);
      } finally {
        if (seq === previewSeqRef.current) setPreviewLoading(false);
      }
    },
    [onError, projectName, projectPath, workMode],
  );

  useEffect(() => {
    let stale = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: projectPath })
      .then((read) => {
        if (stale || touchedRef.current) return;
        setMode(
          normalizeSessionInjectionMode(read.config.sessionInjectionMode),
        );
        setTemplateDraft(read.config.sessionInjectionTemplate ?? "");
      })
      .catch((reason) => {
        if (!stale) {
          const message = `读取项目说明设置失败：${String(reason)}`;
          setError(message);
          onError?.(message);
        }
      });
    return () => {
      stale = true;
    };
  }, [onError, projectPath]);

  const loadSectionValues = useCallback(() => {
    loadSessionTemplateValues({ name: projectName, path: projectPath, workMode })
      .then(setSectionValues)
      .catch(() => setSectionValues({}));
  }, [projectName, projectPath, workMode]);
  useEffect(() => {
    if (open && mode === "custom" && sectionValues === null) loadSectionValues();
  }, [open, mode, sectionValues, loadSectionValues]);

  // 预览跟着档位与模板草稿走：展开时停手 400ms 就按当前草稿重渲（不等保存）
  useEffect(() => {
    if (!open || !previewOpen) return;
    const timer = window.setTimeout(() => void loadPreview(mode, templateDraft), 400);
    return () => window.clearTimeout(timer);
  }, [open, previewOpen, mode, templateDraft, loadPreview]);

  useEffect(() => {
    if (!open || mode !== "custom" || !rawMode) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 320)}px`;
  }, [open, mode, rawMode, templateDraft]);

  // 保存串行化 + 单键原子写：写盘走 project_set_session_injection（后端配置锁内
  // 只改两个注入键，不再整卡读改写——同卡片的规则面板等写者互不覆盖）；链式排队
  // 保证 blur 保存与切模式保存（点页签先触发 blur）的落盘顺序即操作顺序。
  // 「最后一次入队」放 ref：普通 let 每次渲染重置，跨渲染的两次保存会都落盘、旧的盖新的
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastEnqueuedRef = useRef<{ mode: SessionInjectionMode; template: string } | null>(null);

  function save(nextMode: SessionInjectionMode, nextTemplate: string) {
    touchedRef.current = true;
    const attempt = { mode: nextMode, template: nextTemplate };
    lastEnqueuedRef.current = attempt;
    saveChainRef.current = saveChainRef.current
      .then(async () => {
        if (attempt !== lastEnqueuedRef.current) return;
        try {
          await invoke("project_set_session_injection", {
            path: projectPath,
            mode: nextMode,
            template: nextTemplate,
          });
          setError(null);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
          onSaved?.();
        } catch (reason) {
          const message = `保存项目说明设置失败：${String(reason)}`;
          setError(message);
          onError?.(message);
        }
      })
      .catch(() => {
        /* 链不断：单次失败只报错不拖垮后续保存 */
      });
  }

  // 关抽屉（Esc / 点遮罩）时编辑框来不及失焦，卸载前把没保存的模板补存一次——
  // 否则刚写的模板随抽屉一起丢
  const pendingRef = useRef({ mode, template: templateDraft });
  pendingRef.current = { mode, template: templateDraft };
  useEffect(
    () => () => {
      const last = lastEnqueuedRef.current;
      const now = pendingRef.current;
      if (!touchedRef.current) return;
      if (last && last.mode === now.mode && last.template === now.template) return;
      void invoke("project_set_session_injection", {
        path: projectPath,
        mode: now.mode,
        template: now.template,
      }).catch(() => {});
    },
    // 只在卸载（或换项目）时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPath],
  );

  function switchMode(next: SessionInjectionMode) {
    if (next === mode) return;
    setMode(next);
    // 切到自定义时模板还空：直接从默认版式起步——空模板会按「自动」走，选了自定义却看不出区别
    const template =
      next === "custom" && !templateDraft.trim()
        ? DEFAULT_SESSION_TEMPLATE
        : templateDraft;
    if (template !== templateDraft) setTemplateDraft(template);
    save(next, template);
  }

  async function resetTemplate() {
    const current = templateDraft.trim();
    if (current && current !== DEFAULT_SESSION_TEMPLATE.trim()) {
      const ok = await confirmDialog("用默认模板替换现在写的内容？替换后原内容不会保留。", {
        confirmText: "替换",
      });
      if (!ok) return;
    }
    touchedRef.current = true;
    setTemplateDraft(DEFAULT_SESSION_TEMPLATE);
    save("custom", DEFAULT_SESSION_TEMPLATE);
  }

  function insertToken(token: string) {
    touchedRef.current = true;
    const el = textareaRef.current;
    if (!el) {
      setTemplateDraft((current) => current + token);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setTemplateDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  // 未识别点名与渲染端同一判据（isSessionTemplateKey：键 trim 后对清单），
  // 不能一个整串精确匹配、一个 trim 查表——口径分叉会把 {{ 课题主题 }} 这类
  // 带空格的已知占位符误报成「会原样注入」。
  const unknownTokens = [
    ...new Set(
      (templateDraft.match(/\{\{[^{}\n]+\}\}/g) ?? []).filter(
        (token) => !isSessionTemplateKey(token.slice(2, -2)),
      ),
    ),
  ];
  const emptyCustom = mode === "custom" && !templateDraft.trim();
  const isDefaultTemplate = templateDraft.trim() === DEFAULT_SESSION_TEMPLATE.trim();
  // 单独成行的 ---- 与 composeLaunchPrompt 拼接「你说的话」的分隔符同形，
  // 出现在模板里会让 AI 分不清说明到哪结束、你的指令从哪开始
  const separatorClash = /^\s*-{2,}\s*$/m.test(templateDraft);

  // 字号写在 section 上：全站 button { font: inherit } 会吞掉按钮上的 text-*，
  // 页签、占位符按钮只能从容器继承（2026-10-17 截图：页签与占位符都大了一号）
  return (
    <section className={`text-xs ${compact ? "" : "space-y-3"}`} aria-label="项目说明">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        <span className="font-medium text-l3">项目说明</span>
        <span className="min-w-0 flex-1 truncate text-micro text-l4">
          {MODE_LABEL[mode]}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <p className="text-micro leading-5 text-l4">
            在这个项目里开对话时，悄悄附在你第一句前面，让 AI 知道是哪个课题（侧栏课题的 ＋、项目页「＋ 新对话」、新对话换到这个项目、问 AI、编程页「进入」、定时任务开聊）。
            聊天里它折成一行「已附项目说明」，自动起名不看它。开工任务书与验收写入不受影响。
          </p>
          <SegTabs<SessionInjectionMode>
            items={[
              { id: "auto", label: "自动" },
              { id: "custom", label: "自定义" },
              { id: "off", label: "不附带" },
            ]}
            value={mode}
            onChange={switchMode}
          />
          {mode === "auto" && (
            <p className="text-micro leading-5 text-l4">
              按项目当时的目录、课题主题、规则、长期知识和已验收内容自动生成，展开下方预览可以看到全文。
            </p>
          )}
          {mode === "custom" && (
            <>
              {rawMode ? (
                <>
                  <textarea
                    ref={textareaRef}
                    className={`${surfaceFieldClass} resize-none overflow-y-auto font-mono leading-5`}
                    value={templateDraft}
                    onChange={(event) => {
                      touchedRef.current = true;
                      setTemplateDraft(event.target.value);
                    }}
                    onBlur={() => save(mode, templateDraft)}
                    placeholder="写你自己的说明；{{名字}} 每次开对话按项目当时内容填入。"
                    aria-label="项目说明模板"
                  />
                  <div className="flex flex-wrap items-center gap-1 text-micro">
                    <span className="mr-0.5 text-l4">插入</span>
                    {SESSION_TEMPLATE_VARS.map((item) => (
                      <button
                        key={item.token}
                        type="button"
                        className="rounded-sm bg-inset px-1.5 py-0.5 font-mono text-l3 hover:bg-hover hover:text-l1"
                        title={item.hint}
                        onClick={() => insertToken(item.token)}
                      >
                        {item.token.slice(2, -2)}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <SessionTemplateEditor
                  value={templateDraft}
                  values={sectionValues}
                  onChange={(text, commit) => {
                    touchedRef.current = true;
                    setTemplateDraft(text);
                    if (commit) save("custom", text);
                  }}
                  onEditSource={() => setRawMode(true)}
                />
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
                <span className="min-w-0 flex-1 leading-5 text-l4">
                  {rawMode
                    ? "{{名字}} 每次开对话按项目当时内容填入，空段自动省略；段与段之间空一行。"
                    : "悬停标签看现在的内容；空的段开对话时自动省略。"}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-sm px-1 py-0.5 text-l3 hover:bg-hover hover:text-l1"
                  onClick={() => {
                    if (rawMode) save(mode, templateDraft);
                    setRawMode((v) => !v);
                  }}
                  title={rawMode ? "回到勾选编辑" : "直接改模板原文（要调整顺序、逐字控制版式时用）"}
                >
                  {rawMode ? "回到勾选" : "编辑源文本"}
                </button>
                {!isDefaultTemplate && (
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1 py-0.5 text-l3 hover:bg-hover hover:text-l1"
                    onClick={() => void resetTemplate()}
                  >
                    {emptyCustom ? "填入默认模板" : "恢复默认模板"}
                  </button>
                )}
              </div>
              {emptyCustom && (
                <p className="text-l2">
                  一项都没选、也没写补充：开对话仍按「自动」带项目说明；不想带任何说明请选「不附带」。
                </p>
              )}
              {unknownTokens.length > 0 && (
                <p className="text-warn-text">
                  未识别的占位符会原样带上：{unknownTokens.join("、")}
                </p>
              )}
              {separatorClash && (
                <p className="text-warn-text">
                  单独成行的 ---- 是应用拼接「你说的话」的分隔符，写进模板会让
                  AI 分不清说明到哪里结束；建议换个写法。
                </p>
              )}
            </>
          )}
          {mode === "off" && (
            <p className="text-l2">
              开对话只发你说的话：AI 不知道项目背景，也不带「按用户这次说的做」的纪律句。
            </p>
          )}
          <div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex min-h-7 flex-1 items-center gap-1.5 text-left"
                onClick={() => setPreviewOpen((v) => !v)}
                aria-expanded={previewOpen}
              >
                <FoldMark open={previewOpen} />
                <span className="font-medium text-l2">预览下次附带的说明</span>
                {previewLoading && (
                  <span className="text-micro text-l4">渲染中…</span>
                )}
              </button>
              {previewOpen && (
                <button
                  type="button"
                  className={ghostActionClass}
                  onClick={() => {
                    void loadPreview(mode, templateDraft);
                    if (mode === "custom") loadSectionValues();
                  }}
                  title="规则、长期知识等改动后，点这里按项目当前内容重新读取"
                  aria-label="重新读取预览"
                >
                  <RotateCw size={12} strokeWidth={1.8} />
                </button>
              )}
            </div>
            {previewOpen && preview !== null && (
              <div className="mt-1">
                {preview.trim() ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md ccode-well p-2 text-micro leading-5 text-l2">
                    {preview}
                  </pre>
                ) : (
                  <p className="rounded-md ccode-well p-2 text-micro text-l3">
                    （不附带：开对话只发你说的话）
                  </p>
                )}
              </div>
            )}
          </div>
          {(saved || error) && (
            <div className="flex items-center gap-2 text-micro">
              {saved && <span className="text-ok-text">✓ 已保存</span>}
              {error && <span className="text-err-text">{error}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
