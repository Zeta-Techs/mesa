import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { primaryActionClass, secondaryActionClass } from "./PageFrame";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { collectFrontendDiagnostics } from "../diagnostics";
import { feedbackEnvLine } from "../feedback";
import { toast } from "../toast";

/** 帮助菜单弹窗族：诊断与日志 / 关于。帮助菜单不跳设置页——
 *  内容能装进弹窗的都就地弹窗，弹窗里留「去完整页」的出口。 */

export type HelpDialogKind = "diag" | "about";

/** 与后端 logbuf::LogEntryDto 对应（SettingsPage 同款本地类型） */
type LogEntry = { ts: string; level: string; source: string; message: string };

/** 诊断与日志：最近日志就地可看 + 一键导出脱敏诊断包（反馈排障的主附件） */
export function HelpDiagnosticsDialog({
  open,
  onClose,
  onOpenFull,
}: {
  open: boolean;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [exporting, setExporting] = useState(false);
  // 导出成功后内联展示路径 +「打开」按钮（停留到关弹窗，比 toast 更跟手）
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLogs(null);
    setExportedPath(null);
    invoke<LogEntry[]>("get_app_log", { limit: 50 })
      .then(setLogs)
      .catch(() => setLogs([]));
  }, [open]);

  const exportBundle = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const path = await invoke<string>("export_diagnostics_bundle", {
        frontend: collectFrontendDiagnostics(),
      });
      setExportedPath(path);
      toast(`诊断包已导出`);
    } catch (e) {
      toast(`诊断包导出失败：${String(e)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="诊断与日志"
      size="lg"
      description="诊断包已脱敏（密钥只留尾号），附到「反馈与提需求」里最有助于定位问题。"
      footer={
        <>
          <button type="button" className={secondaryActionClass} onClick={onOpenFull}>
            完整体检与配置快照（设置 → 诊断）
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={exporting}
            onClick={() => void exportBundle()}
          >
            {exporting ? "导出中…" : "导出诊断包"}
          </button>
        </>
      }
    >
      {exportedPath && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-field ccode-well px-3 py-2 text-xs text-l2">
          <span className="text-ok-text">✓</span>
          <span className="min-w-0 flex-1">诊断包已导出：{exportedPath}</span>
          <button
            type="button"
            className="h-6 shrink-0 rounded-md border border-field bg-strip px-2 text-micro text-l2 hover:bg-hover hover:text-l1"
            onClick={() => void revealItemInDir(exportedPath)}
          >
            打开
          </button>
        </p>
      )}
      <div className="max-h-72 overflow-auto rounded-md border border-field ccode-well p-2 font-mono text-micro leading-5">
        {logs === null ? (
          <p className="px-1 py-2 text-l3">正在读取日志…</p>
        ) : logs.length === 0 ? (
          <p className="px-1 py-2 text-l3">暂无日志。</p>
        ) : (
          logs.map((l, i) => (
            <p
              key={`${l.ts}-${i}`}
              className={l.level === "error" ? "text-err-text" : "text-l2"}
            >
              <span className="text-l3">{l.ts} </span>
              <span className="text-l3">[{l.source}] </span>
              {l.message}
            </p>
          ))
        )}
      </div>
    </Modal>
  );
}

/** 关于 Mesa：版本与构建环境、版权、许可（内页可看第三方清单全文）、致谢、商标说明 */
export function HelpAboutDialog({
  open,
  onClose,
  onFeedback,
}: {
  open: boolean;
  onClose: () => void;
  onFeedback: () => void;
}) {
  // view 双页：about 主页 / notices 第三方许可全文（同一弹窗内切换，避免双层模态）
  const [view, setView] = useState<"about" | "notices">("about");
  const [envLine, setEnvLine] = useState("");
  const [notices, setNotices] = useState<string | null>(null);

  // 视图切换（关于 ↔ 开源许可）后聚焦新视图首个可聚焦元素：被聚焦的按钮随旧
  // 视图卸载会让焦点掉到 body，Modal 的 Tab 陷阱就拦不住背景控件了
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('[role="dialog"] button:not([disabled])')
        ?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    setView("about");
    let alive = true;
    Promise.all([
      getVersion().catch(() => ""),
      invoke<{ os: string; arch: string; channel: string }>("build_info").catch(
        () => null,
      ),
    ]).then(([version, b]) => {
      if (!alive) return;
      setEnvLine(
        feedbackEnvLine({
          version: version || null,
          os: b?.os,
          arch: b?.arch,
          channel: b?.channel,
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const openNotices = async () => {
    if (notices === null) {
      try {
        setNotices(await invoke<string>("read_third_party_notices"));
      } catch (e) {
        toast(`开源许可清单读取失败：${String(e)}`, "warning");
        return;
      }
    }
    setView("notices");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={view === "notices" ? "开源许可" : "关于 Mesa"}
      size={view === "notices" ? "md" : "sm"}
      footer={
        view === "notices" ? (
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() => setView("about")}
          >
            ← 返回
          </button>
        ) : (
          <>
            <button type="button" className={secondaryActionClass} onClick={onFeedback}>
              反馈与提需求
            </button>
            <button
              type="button"
              className={primaryActionClass}
              onClick={() => void openNotices()}
            >
              查看开源许可
            </button>
          </>
        )
      }
    >
      {view === "notices" ? (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs leading-5 text-l2">
          {notices ?? "正在读取…"}
        </pre>
      ) : (
        /* 居中卡片：名字 / 版本环境 / 版权 / 一句许可与商标，四行封顶——
           致谢与数据来源在「开源许可」内页，完整版在设置 → 关于 */
        <div className="flex flex-col items-center gap-1 py-3 text-center">
          <span className="text-xl font-semibold text-l1">Mesa</span>
          <span className="font-mono text-xs text-l3">
            {envLine ? envLine.replace(/^Mesa /, "") : "…"}
          </span>
          <p className="mt-3 text-sm text-l2">© 2026 泽塔前沿科技（杭州）有限公司</p>
          <p className="mt-1 text-xs leading-5 text-l3">
            按 Apache-2.0 开源 · 不是任何 CLI 的官方产品
          </p>
        </div>
      )}
    </Modal>
  );
}
