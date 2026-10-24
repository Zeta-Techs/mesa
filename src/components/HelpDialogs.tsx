import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronRight,
  CircleArrowUp,
  CircleCheck,
  CircleX,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Modal } from "./Modal";
import {
  NoticeBar,
  InlineNotice,
  SegTabs,
  iconActionClass,
  primaryActionClass,
  quietActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { ThirdPartyNotices, loadThirdPartyNotices } from "./ThirdPartyNotices";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import {
  collectFrontendDiagnostics,
  formatLogText,
  logClockTime,
  logLevelCounts,
  logLevelLabel,
  logLocalTime,
  type AppLogEntry,
} from "../diagnostics";
import { feedbackEnvLine } from "../feedback";
import {
  appUpdateProgressLabel,
  appUpdateProgressPct,
} from "../app-update";
import { useAppUpdateInstall } from "../app-update-install";
import { REPO_URL } from "../help-links";
import { revealFolderLabel } from "../path-utils";
import { IS_MAC, IS_WINDOWS } from "../hotkeys";
import { useAppStore } from "../store";
import { toast } from "../toast";
import appIconDark from "../assets/app-icon/dark.png";
import appIconLight from "../assets/app-icon/light.png";
import UpdateNotes from "./UpdateNotes";

/** 帮助菜单弹窗族：诊断与日志 / 检查更新 / 关于。帮助菜单不跳设置页——
 *  内容能装进弹窗的都就地弹窗，弹窗里留「去完整页」的出口。 */

export type HelpDialogKind = "diag" | "update" | "about";

/** GitHub 发布页：更新说明全文与各平台安装包（检查失败时手动下载的出口） */
const RELEASES_URL = `${REPO_URL}/releases`;

const openExternal = (url: string) =>
  openUrl(url).catch(() => toast("浏览器没打开，稍后再试", "warning"));

/** 版本 + 构建环境一行（「Mesa v0.9.3 · macOS · Apple 芯片」），关于与更新弹窗共用 */
function useEnvLine(open: boolean): string {
  const [envLine, setEnvLine] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([
      getVersion().catch(() => ""),
      invoke<{ os: string; arch: string; channel: string }>("build_info").catch(() => null),
    ]).then(([version, b]) => {
      if (!alive) return;
      setEnvLine(
        feedbackEnvLine({ version: version || null, os: b?.os, arch: b?.arch, channel: b?.channel }),
      );
    });
    return () => {
      alive = false;
    };
  }, [open]);
  return envLine;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/** 诊断与日志：最近日志就地可看（按级别筛） + 一键导出脱敏诊断包，导出后可直接附到反馈 */
export function HelpDiagnosticsDialog({
  open,
  onClose,
  onOpenFull,
  onAttachToFeedback,
}: {
  open: boolean;
  onClose: () => void;
  onOpenFull: () => void;
  /** 带着刚导出的诊断包打开反馈表单 */
  onAttachToFeedback: (bundlePath: string) => void;
}) {
  const [logs, setLogs] = useState<AppLogEntry[] | null>(null);
  const [filter, setFilter] = useState<"all" | "issues">("all");
  const [exporting, setExporting] = useState(false);
  // 导出成功后内联展示文件 +「在访达中显示」，停留到关弹窗（比 toast 跟手）
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadLogs = () =>
    invoke<AppLogEntry[]>("get_app_log", { limit: 100 })
      .then(setLogs)
      .catch(() => setLogs([]));

  useEffect(() => {
    if (!open) return;
    setLogs(null);
    setFilter("all");
    setExportedPath(null);
    void loadLogs();
  }, [open]);

  const counts = logLevelCounts(logs ?? []);
  const issueCount = counts.error + counts.warn;
  const shown = (logs ?? []).filter(
    (l) => filter === "all" || l.level === "error" || l.level === "warn",
  );

  // 最新的在最下面：载入与切换筛选后滚到底
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, filter]);

  const exportBundle = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const path = await invoke<string>("export_diagnostics_bundle", {
        frontend: collectFrontendDiagnostics(),
      });
      setExportedPath(path);
      void loadLogs();
    } catch (e) {
      toast(`诊断包导出失败：${String(e)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(formatLogText(shown));
      toast(`已复制 ${shown.length} 条日志`);
    } catch {
      toast("复制失败", "warning");
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!exporting) onClose();
      }}
      title="诊断与日志"
      size="lg"
      description="出了问题先导出诊断包，附到反馈里最有助于定位。包里是系统与运行信息和下面这些日志；密钥已脱敏，不含环境变量。"
      dismissOnBackdrop={!exporting}
      footer={
        <>
          <button
            type="button"
            className={`${quietActionClass} mr-auto`}
            onClick={onOpenFull}
            title="设置 → 诊断：依赖体检、生效配置快照、后台任务"
          >
            依赖体检与配置快照
            <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" className="ml-0.5" />
          </button>
          {exportedPath ? (
            <>
              <button
                type="button"
                className={secondaryActionClass}
                disabled={exporting}
                onClick={() => void exportBundle()}
              >
                {exporting ? "导出中…" : "重新导出"}
              </button>
              <button
                type="button"
                className={primaryActionClass}
                onClick={() => onAttachToFeedback(exportedPath)}
              >
                附到反馈…
              </button>
            </>
          ) : (
            <button
              type="button"
              className={primaryActionClass}
              disabled={exporting}
              onClick={() => void exportBundle()}
            >
              {exporting ? "正在采集…" : "导出诊断包"}
            </button>
          )}
        </>
      }
    >
      {exportedPath && (
        <NoticeBar tone="ok" className="mb-3">
          <span className="block font-medium text-l1">诊断包已导出到下载文件夹</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-micro text-l3" title={exportedPath}>
              {baseName(exportedPath)}
            </span>
            <button
              type="button"
              className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-micro text-l3 hover:bg-hover hover:text-l1"
              onClick={() => void revealItemInDir(exportedPath).catch(() => {})}
            >
              {revealFolderLabel(IS_MAC, IS_WINDOWS)}
            </button>
          </span>
        </NoticeBar>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-l2">应用日志</span>
        {logs !== null && (
          <span className="text-micro text-l4">
            {counts.error > 0 && <span className="text-err-text">{counts.error} 条错误</span>}
            {counts.error > 0 && counts.warn > 0 && " · "}
            {counts.warn > 0 && <span className="text-warn-text">{counts.warn} 条警告</span>}
            {issueCount === 0 && logs.length > 0 && "没有错误或警告"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <SegTabs<"all" | "issues">
            items={[
              { id: "all", label: `全部 ${logs?.length ?? 0}` },
              { id: "issues", label: `错误与警告 ${issueCount}` },
            ]}
            value={filter}
            onChange={setFilter}
            className="text-xs"
          />
          <button
            type="button"
            className={iconActionClass}
            aria-label="刷新日志"
            title="刷新"
            onClick={() => void loadLogs()}
          >
            <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={iconActionClass}
            aria-label="复制日志"
            title="复制当前列出的日志"
            disabled={shown.length === 0}
            onClick={() => void copyLogs()}
          >
            <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={listRef}
        className="h-72 overflow-auto rounded-md ccode-well py-1 font-mono text-micro leading-5"
      >
        {logs === null ? (
          <p className="px-3 py-2 text-l3">正在读取日志…</p>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center font-sans">
            {filter === "issues" && logs.length > 0 ? (
              <>
                <CircleCheck size={18} strokeWidth={1.8} aria-hidden="true" className="text-ok-text" />
                <p className="text-xs text-l2">本次运行没有错误或警告</p>
              </>
            ) : (
              <p className="text-xs text-l3">本次运行还没有日志</p>
            )}
          </div>
        ) : (
          shown.map((l, i) => {
            const tag = logLevelLabel(l.level);
            return (
              <div
                key={`${l.ts}-${i}`}
                className="flex gap-2 px-3 py-px hover:bg-hover"
              >
                <span className="shrink-0 text-l4" title={logLocalTime(l.ts)}>
                  {logClockTime(l.ts)}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {tag && (
                    <span
                      className={`mr-1.5 font-sans font-medium ${
                        l.level === "error" ? "text-err-text" : "text-warn-text"
                      }`}
                    >
                      {tag}
                    </span>
                  )}
                  <span className="text-l3">{l.source}</span>
                  <span className="text-l4"> · </span>
                  <span className={l.level === "error" ? "text-l1" : "text-l2"}>{l.message}</span>
                </span>
              </div>
            );
          })
        )}
      </div>
      <p className="mt-1.5 text-micro text-l4">
        最近 100 条，只含本次运行（重启即清空）；时间为本机时区，悬停可看日期。
      </p>
    </Modal>
  );
}

/** 更新弹窗的状态块：左图标 + 标题/说明 */
function StatusBlock({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg ccode-well p-4">
      {/* 壳取标题的字号，图标对准标题那一行 */}
      <span className="ccode-icon-line text-sm">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-l1">{title}</p>
        {children && <div className="mt-1 text-xs leading-5 text-l3">{children}</div>}
      </div>
    </div>
  );
}

/** 检查更新：打开即当场检查（已知有新版则不重查），结果、更新说明、下载进度都在弹窗里；
 *  安装与设置 → 更新同一套流程（useAppUpdateInstall）。 */
export function HelpUpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const appUpdate = useAppStore((s) => s.appUpdate);
  const status = useAppStore((s) => s.appUpdateStatus);
  const statusError = useAppStore((s) => s.appUpdateError);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);
  const envLine = useEnvLine(open);
  const { installing, progress, error: installError, install } = useAppUpdateInstall();

  useEffect(() => {
    if (!open) return;
    const s = useAppStore.getState();
    if (s.appUpdate || s.appUpdateStatus === "checking") return;
    void s.checkAppUpdate();
  }, [open]);

  const checking = !appUpdate && (status === "checking" || status === "idle");
  const close = () => {
    if (!installing) onClose();
  };
  const releasesLink = (label: string) => (
    <button
      type="button"
      className={`${quietActionClass} mr-auto gap-1`}
      onClick={() => void openExternal(RELEASES_URL)}
    >
      {label}
      <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
  const iconCls = "size-5";

  let body: ReactNode;
  let footer: ReactNode;
  if (appUpdate) {
    const pct = progress ? appUpdateProgressPct(progress.downloaded, progress.total) : null;
    body = (
      <div className="space-y-3">
        <StatusBlock
          icon={<CircleArrowUp strokeWidth={1.8} aria-hidden="true" className={`${iconCls} text-cta`} />}
          title={
            <>
              发现新版本 <span className="font-mono">v{appUpdate.version}</span>
            </>
          }
        >
          当前 v{appUpdate.currentVersion}。安装完成后 Mesa 会自动重启，进行中的对话请先保存。
        </StatusBlock>
        {installing && (
          <div>
            <div className="mb-1 flex justify-between text-micro text-l3">
              <span>{appUpdateProgressLabel(progress?.downloaded ?? 0, progress?.total ?? null)}</span>
              {pct !== null && <span className="tabular-nums">{pct}%</span>}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-inset">
              <div
                className="h-full bg-ok-text transition-[width]"
                style={{ width: `${pct ?? 15}%` }}
              />
            </div>
          </div>
        )}
        {installError && !installing && (
          <InlineNotice tone="err">{`安装失败：${installError}`}</InlineNotice>
        )}
        {appUpdate.body?.trim() && <UpdateNotes text={appUpdate.body.trim()} />}
      </div>
    );
    footer = (
      <>
        {releasesLink("发布页")}
        {!installing && (
          <button type="button" className={secondaryActionClass} onClick={onClose}>
            稍后
          </button>
        )}
        <button
          type="button"
          className={primaryActionClass}
          disabled={installing}
          onClick={() => void install()}
        >
          {installing ? "正在下载…" : "下载并安装"}
        </button>
      </>
    );
  } else if (checking) {
    body = (
      <StatusBlock
        icon={<LoaderCircle strokeWidth={1.8} aria-hidden="true" className={`${iconCls} animate-spin text-l3`} />}
        title="正在检查更新…"
      >
        向更新源查询最新版本（配了国内镜像的版本先查镜像，再查 GitHub），网络慢时最多等 30 秒。
      </StatusBlock>
    );
    footer = (
      <>
        {releasesLink("发布记录")}
        <button type="button" className={primaryActionClass} disabled>
          检查中…
        </button>
      </>
    );
  } else if (status === "dev") {
    body = (
      <StatusBlock
        icon={<Info strokeWidth={1.8} aria-hidden="true" className={`${iconCls} text-l3`} />}
        title="开发模式不检查应用更新"
      >
        打包后的正式版才会检查。{envLine && <span className="font-mono">{envLine}</span>}
      </StatusBlock>
    );
    footer = (
      <>
        {releasesLink("发布记录")}
        <button type="button" className={primaryActionClass} onClick={onClose}>
          知道了
        </button>
      </>
    );
  } else if (status === "error") {
    body = (
      <StatusBlock
        icon={<CircleX strokeWidth={1.8} aria-hidden="true" className={`${iconCls} text-err-text`} />}
        title="检查更新失败"
      >
        {statusError ? `${statusError}。` : ""}
        可以稍后重试，也可以到 GitHub 发布页手动下载安装包——覆盖安装后设置与数据都在。
      </StatusBlock>
    );
    footer = (
      <>
        {releasesLink("去发布页下载")}
        <button type="button" className={primaryActionClass} onClick={() => void checkAppUpdate()}>
          重试
        </button>
      </>
    );
  } else {
    body = (
      <StatusBlock
        icon={<CircleCheck strokeWidth={1.8} aria-hidden="true" className={`${iconCls} text-ok-text`} />}
        title="已是最新版本"
      >
        {envLine ? <span className="font-mono">{envLine}</span> : "…"}
      </StatusBlock>
    );
    footer = (
      <>
        {releasesLink("发布记录")}
        <button type="button" className={secondaryActionClass} onClick={() => void checkAppUpdate()}>
          重新检查
        </button>
        <button type="button" className={primaryActionClass} onClick={onClose}>
          完成
        </button>
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="检查更新"
      size="md"
      dismissOnBackdrop={!installing}
      footer={footer}
    >
      {body}
    </Modal>
  );
}

/** 关于里的一行入口：图标 + 名称 + 说明 + 行尾标记（外链 ↗ / 内页 ›） */
function AboutLinkRow({
  icon,
  label,
  hint,
  external,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  external?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-hover"
    >
      <span className="shrink-0 text-l3">{icon}</span>
      <span className="shrink-0 text-xs text-l1">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-micro text-l4">{hint}</span>
      {external ? (
        <ExternalLink size={11} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
      ) : (
        <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-l4" />
      )}
    </button>
  );
}

const GITHUB_MARK = (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8"
    />
  </svg>
);

/** 关于 Mesa：身份（图标 / 版本环境，可一键复制）、更新状态、仓库与许可入口、版权与隐私。
 *  开源许可在同一弹窗内切页（避免双层模态），完整版在设置 → 关于 */
export function HelpAboutDialog({
  open,
  onClose,
  onFeedback,
  onCheckUpdate,
}: {
  open: boolean;
  onClose: () => void;
  onFeedback: () => void;
  onCheckUpdate: () => void;
}) {
  const [view, setView] = useState<"about" | "notices">("about");
  const [notices, setNotices] = useState<string | null>(null);
  const envLine = useEnvLine(open);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const status = useAppStore((s) => s.appUpdateStatus);
  const iconStyle = useAppStore((s) => s.settings?.appIconStyle);

  useEffect(() => {
    if (open) setView("about");
  }, [open]);

  // 视图切换后聚焦新视图首个可聚焦元素：被聚焦的按钮随旧视图卸载会让焦点掉到 body，
  // Modal 的 Tab 陷阱就拦不住背景控件了
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[role="dialog"] button:not([disabled])')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, view]);

  const openNotices = async () => {
    const text = notices ?? (await loadThirdPartyNotices());
    if (text === null) return;
    setNotices(text);
    setView("notices");
  };

  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(envLine);
      toast("版本信息已复制");
    } catch {
      toast("复制失败", "warning");
    }
  };

  // 更新状态只读 store（启动时已查过），不在这里发请求；点一下进检查更新弹窗
  const updateState = appUpdate
    ? { dot: "bg-ok-text", text: `v${appUpdate.version} 可更新` }
    : status === "none"
      ? { dot: "bg-l4", text: "已是最新版本" }
      : status === "error"
        ? { dot: "bg-err-text", text: "上次检查失败" }
        : status === "dev"
          ? { dot: "bg-l4", text: "开发模式不检查更新" }
          : { dot: "bg-l4", text: "检查更新" };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view === "notices" ? "开源许可与致谢" : "关于 Mesa"}
      description={
        view === "notices" ? "Mesa 按 Apache-2.0 发布；下面是它用到的开源组件、字体与数据来源。" : undefined
      }
      size={view === "notices" ? "lg" : "md"}
      footer={
        view === "notices" ? (
          <button type="button" className={secondaryActionClass} onClick={() => setView("about")}>
            返回
          </button>
        ) : (
          <button type="button" className={secondaryActionClass} onClick={onFeedback}>
            反馈与提需求
          </button>
        )
      }
    >
      {view === "notices" ? (
        <ThirdPartyNotices text={notices} />
      ) : (
        <div className="flex flex-col items-center text-center">
          <img
            src={iconStyle === "light" ? appIconLight : appIconDark}
            alt=""
            aria-hidden="true"
            className="h-16 w-16"
          />
          <span className="mt-2 text-lg font-semibold text-l1">Mesa</span>
          <span className="text-xs text-l3">AI 科研工作台</span>
          <span className="mt-2 flex items-center gap-1">
            <span className="font-mono text-xs text-l2">
              {envLine ? envLine.replace(/^Mesa /, "") : "…"}
            </span>
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
              aria-label="复制版本信息"
              title="复制版本信息（报问题时贴上）"
              disabled={!envLine}
              onClick={() => void copyEnv()}
            >
              <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
          {/* 全站 button { font: inherit }：字号挂在外层 */}
          <span className="mt-1 text-micro">
            <button
              type="button"
              onClick={onCheckUpdate}
              className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-l3 hover:bg-hover hover:text-l1"
            >
              <span className={`size-1.5 rounded-full ${updateState.dot}`} aria-hidden="true" />
              {updateState.text}
            </button>
          </span>

          <div className="mt-4 w-full rounded-lg ccode-well p-1">
            <AboutLinkRow
              icon={GITHUB_MARK}
              label="GitHub 仓库"
              hint="源码、发布记录与 Issue"
              external
              onClick={() => void openExternal(REPO_URL)}
            />
            <AboutLinkRow
              icon={<ScrollText size={14} strokeWidth={1.8} aria-hidden="true" />}
              label="开源许可与致谢"
              hint="用到的组件、字体与数据来源"
              onClick={() => void openNotices()}
            />
          </div>

          <p
            className="mt-3 flex items-start gap-1.5 text-left text-micro leading-4 text-l3"
            title="API 密钥只存本机（仅本人可读的文件）；各 CLI 的会话目录只读。会联网的只有：检查更新（向 Mesa 的更新源问版本：发布页或官方镜像）、文献同步 / 下载 / 远查（把 DOI 或刊名发给 JabRef、NLM、ShowJCR、Unpaywall、Crossref、OpenAlex）、你主动发送的反馈"
          >
            <span className="ccode-icon-line">
              <ShieldCheck size={12} strokeWidth={1.8} aria-hidden="true" />
            </span>
            密钥只存本机；除检查更新、文献检索和你发出的反馈外，不上传任何数据。
          </p>
          <p className="mt-3 text-micro leading-4 text-l4">
            © 2026 泽塔前沿科技（杭州）有限公司 · Apache-2.0
            <br />
            不是 Claude Code、Codex 等任何 CLI 的官方产品，各家名称与商标归其所有者。
          </p>
        </div>
      )}
    </Modal>
  );
}
