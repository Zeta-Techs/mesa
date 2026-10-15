import { useEffect, useMemo, useState } from "react";
import {
  Checkbox,
  fieldClass,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { officialModelAllowed } from "../model-switch";
import {
  loadAskAiRemembered,
  saveAskAiRemembered,
  askAiDirectLaunch,
  buildAskAiPending,
  type AskAiFile,
} from "../ask-ai";
import { projectChatReuseKey } from "../work-mode";
import { Modal } from "./Modal";
import { composeLaunchPrompt } from "../project-context";
import { loadProjectContextPack } from "../project-context-load";
import { goalReviewCopy } from "../goal-review";
import { invoke } from "@tauri-apps/api/core";
import type { TaskDto } from "../types";
import { goalRunTerminalFields, prepareGoalRun } from "../goal-run";

export function beginAskAi(
  file: AskAiFile,
  opts?: { forcePick?: boolean },
): void {
  void (async () => {
    const pack = await loadProjectContextPack({
      name: file.name,
      path: file.root || file.cwd,
      workMode: file.workMode,
      writeReview: false,
      kind: "session",
    });
    const userPrompt =
      file.prompt !== undefined
        ? file.prompt
        : file.path.trim()
          ? `请看这份文件：${/\s/.test(file.path) ? `"${file.path}"` : file.path}`
          : "";
    const next: AskAiFile = {
      ...file,
      prompt: composeLaunchPrompt(pack, userPrompt),
    };
    const { profiles, setAskAiReq, setPendingTerminal, setPage } =
      useAppStore.getState();
    const remembered = loadAskAiRemembered();
    const direct = askAiDirectLaunch(
      next,
      profiles,
      remembered,
      opts?.forcePick,
    );
    if (direct) {
      setPendingTerminal(buildAskAiPending(next, direct));
      setPage("terminal");
      return;
    }
    setAskAiReq(next);
  })();
}

/** 项目侧栏「＋ 新对话」：在项目根开聊，不预览文件。⌘/Ctrl 点可重选配置。 */
export function beginProjectChat(
  input: {
    cwd: string;
    name: string;
    kind: "office" | "coding" | "research";
    preferredAgent?: string | null;
    preferredProfile?: string | null;
    preferredModel?: string | null;
  },
  opts?: { forcePick?: boolean },
): void {
  beginAskAi(
    {
      path: "",
      name: input.name,
      cwd: input.cwd,
      root: input.cwd,
      reuseKey: projectChatReuseKey(input.kind, input.cwd),
      prompt: "",
      preview: false,
      preferredAgent: input.preferredAgent,
      preferredProfile: input.preferredProfile,
      preferredModel: input.preferredModel,
      workMode: input.kind,
    },
    opts,
  );
}

export default function AskAiModal() {
  const req = useAppStore((s) => s.askAiReq);
  const setAskAiReq = useAppStore((s) => s.setAskAiReq);
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  const remembered = useMemo(loadAskAiRemembered, [req]);
  const installed = useMemo(
    () => new Set(agents.filter((a) => a.binaryPath).map((a) => a.id)),
    [agents],
  );
  const agentOptions = useMemo(
    () =>
      [...AGENTS].sort(
        (a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)),
      ),
    [installed],
  );

  const [agentId, setAgentId] = useState(
    () => remembered?.agentId ?? agentOptions[0]?.id ?? "claude-code",
  );
  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [profileId, setProfileId] = useState(() => remembered?.profileId ?? "");
  const [model, setModel] = useState(() => remembered?.model ?? "");
  const [useDefault, setUseDefault] = useState(
    () => remembered?.useDefault ?? false,
  );
  const [writeReview, setWriteReview] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    const r = loadAskAiRemembered();
    const preferred = req.preferredAgent?.trim();
    const nextAgent =
      (preferred && profiles.some((p) => p.agent === preferred)
        ? preferred
        : r?.agentId) ??
      agentOptions[0]?.id ??
      "claude-code";
    setAgentId(nextAgent);
    const list = profiles.filter((p) => p.agent === nextAgent);
    const preferredProfile = req.preferredProfile?.trim();
    const nextProfile =
      (preferredProfile && list.some((p) => p.id === preferredProfile)
        ? preferredProfile
        : r?.profileId && list.some((p) => p.id === r.profileId)
          ? r.profileId
          : list[0]?.id) ?? "";
    setProfileId(nextProfile);
    const preferredModel = req.preferredModel?.trim() ?? "";
    const nextModels = list.find((p) => p.id === nextProfile)?.models ?? [];
    setModel(
      preferredModel && nextModels.includes(preferredModel)
        ? preferredModel
        : (r?.model ?? ""),
    );
    setUseDefault(r?.useDefault ?? false);
    setWriteReview(false);
    setStarting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  useEffect(() => {
    if (!agentProfiles.some((p) => p.id === profileId))
      setProfileId(agentProfiles[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles]);

  const selected = agentProfiles.find((p) => p.id === profileId);
  const official = selected?.accountType === "official";

  useEffect(() => {
    if (!selected) return;
    if (official && !officialModelAllowed(agentId, model)) {
      setModel(selected.models[0] ?? "");
    } else if (
      selected.models.length > 0 &&
      model &&
      !selected.models.includes(model)
    ) {
      setModel(selected.models[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  if (!req) return null;
  const file = req;

  function close() {
    setAskAiReq(null);
  }

  async function start() {
    if (!profileId || starting) return;
    setStartError(null);
    const choice = { agentId, profileId, model: model.trim() };
    saveAskAiRemembered({ ...choice, useDefault });
    const projectChat = !file.path.trim();
    if (projectChat && writeReview && file.workMode && file.workMode !== "coding") {
      setStarting(true);
      try {
        const task = await invoke<TaskDto>("task_create", {
          input: {
            projectRoot: file.cwd,
            kind: file.workMode === "office" ? "office_doc" : "free_research",
            name: file.name,
            description: "项目对话（验收后写入）",
            inputPaths: ["."],
            outputPaths: ["."],
            permission: "write_tree",
            agent: agentId,
            profileId,
            // B2：验收后写入的目标也带上这次选的模型（goal 表单同款三档回落）
            model: choice.model || null,
          },
        });
        const { run, prompt } = await prepareGoalRun({
          projectName: file.name,
          projectPath: file.cwd,
          workMode: file.workMode,
          task,
          agent: agentId,
          profileId,
          goalLine: "",
          packGoal: null,
        });
        setPendingTerminal({
          ...buildAskAiPending({ ...file, prompt }, choice),
          ...goalRunTerminalFields(task, run, prompt),
        });
        setPage("terminal");
        close();
      } catch (error) {
        setStartError(String(error));
        setStarting(false);
        return;
      }
      return;
    }
    setPendingTerminal(buildAskAiPending(file, choice));
    setPage("terminal");
    close();
  }

  return (
    <Modal open title="问 AI" onClose={close} size="sm" description={file.path.trim()
      ? "选 Agent 和配置再开。默认落在终端，右边打开这份文件。"
      : "选 Agent 和配置再开。默认落在终端。"}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-l3">Agent</span>
            <select
              className={fieldClass}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setModel("");
              }}
            >
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {installed.has(a.id) ? "" : "（未检测到）"}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-l3">配置</span>
            <select
              className={fieldClass}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {agentProfiles.length === 0 ? (
                <option value="">该 agent 还没有配置</option>
              ) : (
                agentProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.accountType === "official" ? "（官方账号）" : ""}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-l3">模型</span>
            <input
              className={fieldClass}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                official
                  ? "官方账号可留空，用 CLI 默认"
                  : selected?.models[0] || "可选"
              }
              list="ask-ai-models"
            />
            <datalist id="ask-ai-models">
              {(selected?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          {!file.path.trim() && <p className="mb-2 text-xs text-l3">{writeReview ? "在独立副本工作，文件经你验收后写回项目。" : "直接在项目目录工作，改动即时生效；不是只读讨论或隔离副本。"}</p>}
          {!file.path.trim() && file.workMode && file.workMode !== "coding" && (
            <Checkbox
              className="mb-3 text-xs text-l3"
              checked={writeReview}
              onChange={setWriteReview}
              label={goalReviewCopy(file.workMode).chatWriteReview}
            />
          )}
          <Checkbox
            className="mb-3 text-xs text-l3"
            checked={useDefault}
            onChange={setUseDefault}
            label="设为默认"
          />
          {startError && <p role="alert" className="mb-2 text-xs text-err-text">{startError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className={secondaryActionClass}
              onClick={close}
            >
              取消
            </button>
            <button
              type="submit"
              className={primaryActionClass}
              disabled={!profileId || starting}
              autoFocus
            >
              {starting ? "正在准备…" : "开始"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
