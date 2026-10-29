import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  afterOpenHint,
  dialogTitle,
  needsDialog,
  primaryAction,
  sessionTarget,
  sortChecks,
  type ClientInfoDto,
  type ClientOpenTarget,
  type HandoffFixDto,
  type HandoffPlanDto,
} from "../client-open";
import { Info, ShieldCheck } from "lucide-react";
import type { SessionMetaDto } from "../types";
import { toast } from "../toast";
import { Modal } from "./Modal";
import {
  InlineNotice,
  ghostActionClass,
  primaryActionClass,
  rowActionClass,
} from "./PageFrame";

type DialogState =
  | { kind: "closed" }
  | { kind: "choose"; target: ClientOpenTarget; options: ClientInfoDto[] }
  | {
      kind: "confirm";
      target: ClientOpenTarget;
      plan: HandoffPlanDto;
      fixProfileId: string | null;
      busy: boolean;
      error: string | null;
    };

const TONE = {
  ok: "ok",
  note: "info",
  warn: "warn",
  fix: "warn",
  block: "err",
} as const;

/**
 * 「在 GUI 客户端里打开」的统一入口（设计 docs/design-client-handoff.md）：
 * 先让后端只读预检，全部通过就直接打开；有要让用户知道的事（渠道要补写、渠道会变、
 * 两边同时写、被拦下）才弹确认层。把 `dialog` 渲染在页面里即可。
 */
export function useClientOpen(active = true) {
  const [clients, setClients] = useState<ClientInfoDto[]>([]);
  const [state, setState] = useState<DialogState>({ kind: "closed" });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    invoke<ClientInfoDto[]>("client_open_list")
      .then((list) => alive && setClients(list))
      .catch(() => alive && setClients([]));
    return () => {
      alive = false;
    };
  }, [active]);

  const sessionClients = useCallback(
    (agent: string) =>
      clients.filter((c) => c.installed && c.agent === agent && c.canSession),
    [clients],
  );
  const projectClients = useMemo(
    () => clients.filter((c) => c.installed && c.canProject),
    [clients],
  );

  const launch = useCallback(
    async (
      plan: HandoffPlanDto,
      target: ClientOpenTarget,
      fixProfileId: string | null,
    ) => {
      try {
        await invoke("client_open_launch", {
          clientId: plan.clientId,
          target,
          fix:
            plan.fix && fixProfileId
              ? { kind: plan.fix.kind, profileId: fixProfileId }
              : null,
        });
        setState({ kind: "closed" });
        toast(`已交给${plan.display}`, "success");
      } catch (e) {
        const msg = String(e);
        setState((cur) =>
          cur.kind === "confirm"
            ? { ...cur, busy: false, error: msg }
            : cur,
        );
        if (needsDialog(plan) === false) toast(msg, "error");
      }
    },
    [],
  );

  const run = useCallback(
    async (clientId: string, target: ClientOpenTarget) => {
      let plan: HandoffPlanDto;
      try {
        plan = await invoke<HandoffPlanDto>("client_open_plan", {
          clientId,
          target,
        });
      } catch (e) {
        toast(String(e), "error");
        return;
      }
      if (!needsDialog(plan)) {
        await launch(plan, target, null);
        return;
      }
      setState({
        kind: "confirm",
        target,
        plan,
        fixProfileId: plan.fix?.candidates[0]?.profileId ?? null,
        busy: false,
        error: null,
      });
    },
    [launch],
  );

  const start = useCallback(
    (options: ClientInfoDto[], target: ClientOpenTarget) => {
      if (options.length === 0) {
        toast("没有找到可用的客户端", "warning");
      } else if (options.length === 1) {
        void run(options[0].clientId, target);
      } else {
        setState({ kind: "choose", target, options });
      }
    },
    [run],
  );

  const openSession = useCallback(
    (s: SessionMetaDto, liveInMesa: boolean, clientId?: string) => {
      const target = sessionTarget(s, liveInMesa);
      const options = sessionClients(s.agent);
      const picked = clientId
        ? options.filter((c) => c.clientId === clientId)
        : options;
      start(picked, target);
    },
    [sessionClients, start],
  );

  const openProject = useCallback(
    (path: string) => start(projectClients, { kind: "project", path }),
    [projectClients, start],
  );

  const close = () => setState({ kind: "closed" });

  const dialog = (
    <ClientOpenDialog
      state={state}
      onClose={close}
      onPick={(clientId, target) => void run(clientId, target)}
      onFixProfile={(id) =>
        setState((cur) =>
          cur.kind === "confirm" ? { ...cur, fixProfileId: id } : cur,
        )
      }
      onConfirm={() => {
        if (state.kind !== "confirm") return;
        setState({ ...state, busy: true, error: null });
        void launch(state.plan, state.target, state.fixProfileId);
      }}
    />
  );

  return { clients, sessionClients, projectClients, openSession, openProject, dialog };
}

function ClientOpenDialog({
  state,
  onClose,
  onPick,
  onFixProfile,
  onConfirm,
}: {
  state: DialogState;
  onClose: () => void;
  onPick: (clientId: string, target: ClientOpenTarget) => void;
  onFixProfile: (profileId: string) => void;
  onConfirm: () => void;
}) {
  if (state.kind === "closed") {
    return <Modal open={false} title="" onClose={onClose}>{null}</Modal>;
  }

  if (state.kind === "choose") {
    return (
      <Modal open title="用哪个客户端打开？" size="sm" onClose={onClose}>
        <div className="flex flex-col gap-2">
          {state.options.map((c) => (
            <button
              key={c.clientId}
              type="button"
              className={`${rowActionClass} h-9 justify-start`}
              onClick={() => {
                onClose();
                onPick(c.clientId, state.target);
              }}
            >
              {c.display}
              {c.version ? (
                <span className="ml-2 text-micro text-l4">{c.version}</span>
              ) : null}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  const { plan, busy, error, fixProfileId } = state;
  const primary = primaryAction(plan);
  const blocked = plan.verdict === "blocked";
  const missingClient = plan.checks.some((c) => c.id === "client_missing");
  return (
    <Modal
      open
      title={dialogTitle(plan)}
      size="md"
      dismissOnBackdrop={!busy}
      onClose={() => !busy && onClose()}
      footer={
        <>
          {blocked && missingClient && plan.downloadUrl && (
            <button
              type="button"
              className={ghostActionClass}
              onClick={() => void openUrl(plan.downloadUrl!)}
            >
              去下载
            </button>
          )}
          <button
            type="button"
            className={ghostActionClass}
            disabled={busy}
            onClick={onClose}
          >
            {blocked ? "知道了" : "取消"}
          </button>
          {primary.enabled && (
            <button
              type="button"
              className={primaryActionClass}
              disabled={busy || (plan.fix != null && !fixProfileId)}
              onClick={onConfirm}
            >
              {busy ? "处理中…" : primary.label}
            </button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {sortChecks(plan.checks).map((c) => (
            <InlineNotice key={c.id} tone={TONE[c.status]}>
              {c.text}
            </InlineNotice>
          ))}
        </div>
        {plan.fix && (
          <FixPlan
            fix={plan.fix}
            display={plan.display}
            level={plan.level}
            picked={fixProfileId}
            busy={busy}
            onPick={onFixProfile}
          />
        )}
        {error && <InlineNotice tone="err">{error}</InlineNotice>}
        {!blocked && (
          <p className="flex items-start gap-1.5 border-t border-hairline pt-3 text-micro leading-4 text-l4">
            <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            {afterOpenHint(plan.display)}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** 要补写渠道定义时，先把「点了会发生什么」按顺序摆出来，再让人挑用哪个连接；写盘细节（明文、备份、撤销）收成一行小字 */
function FixPlan({
  fix,
  display,
  level,
  picked,
  busy,
  onPick,
}: {
  fix: HandoffFixDto;
  display: string;
  level: "session" | "project";
  picked: string | null;
  busy: boolean;
  onPick: (profileId: string) => void;
}) {
  const chosen = fix.candidates.find((c) => c.profileId === picked) ?? fix.candidates[0];
  const many = fix.candidates.length > 1;
  return (
    <div className="ccode-well flex flex-col gap-3 rounded-xl p-4 text-xs">
      {many && (
        <fieldset className="flex flex-col gap-1.5" disabled={busy}>
          <legend className="mb-1.5 font-medium text-l2">用哪个连接补写</legend>
          {fix.candidates.map((c) => {
            const on = c.profileId === picked;
            return (
              <label
                key={c.profileId}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                  on ? "border-cta bg-cta/10" : "border-hairline hover:bg-hover"
                }`}
              >
                <input
                  type="radio"
                  name="client-open-fix"
                  className="accent-[var(--color-cta)]"
                  checked={on}
                  onChange={() => onPick(c.profileId)}
                />
                <span className={`min-w-0 flex-1 truncate ${on ? "text-l1" : "text-l2"}`}>{c.name}</span>
                {c.keyHint && <span className="shrink-0 font-mono text-micro text-l4">{c.keyHint}</span>}
              </label>
            );
          })}
        </fieldset>
      )}
      <p className={`font-medium text-l2${many ? " mt-1" : ""}`}>点「写入并打开」后 Mesa 会：</p>
      <ol className="flex flex-col gap-2 text-l2">
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-field text-micro tabular-nums text-l3">1</span>
          <span className="leading-5">
            把连接{chosen ? `「${chosen.name}」` : ""}的地址和密钥写进{" "}
            <code className="rounded bg-field px-1 font-mono text-micro text-l2">~/.codex/config.toml</code>
            ，渠道名「{fix.blockName}」；你的默认渠道不变
          </span>
        </li>
        <li className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-field text-micro tabular-nums text-l3">2</span>
          <span className="leading-5">在 {display}打开{level === "session" ? "这条对话" : "这个项目"}</span>
        </li>
      </ol>
      <p className="flex items-start gap-1.5 text-micro leading-4 text-l4">
        <ShieldCheck size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
        密钥以明文写入这个文件；写前自动备份，想还原到连接页 Codex 组的「⋯ → 撤销上次写入」。
      </p>
    </div>
  );
}
