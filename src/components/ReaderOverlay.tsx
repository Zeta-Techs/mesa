import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_MAC, IS_WINDOWS, eventMatchesCombo, READER_MODE_HOTKEY } from "../hotkeys";
import { macOverlayPadClass, useMacFullscreen } from "../mac-titlebar";
import { HoverTip, useHoverTip } from "./HoverTip";
import { LoadingRows } from "./PageFrame";
import { AGENTS } from "../types";
import {
  READER_PCT_DEFAULT_L,
  READER_PCT_DEFAULT_R,
  READER_SPLITTER_PX,
  READER_SPLIT_L_KEY,
  READER_SPLIT_R_KEY,
  READER_SPLIT_T_KEY,
  buildReaderTranslatePrompt,
  bytesToBase64,
  clampReaderPct,
  formatPdfExcerptPrompt,
  formatReaderCapturePrompt,
  loadReaderDark,
  loadReaderPct,
  loadReaderTlPct,
  loadReaderTlPinned,
  loadTlHistory,
  markTlEntrySaved,
  parseBilingual,
  plainFromBilingual,
  readerColumnWidths,
  readerPanelSlideMargin,
  reflowBlockText,
  saveReaderDark,
  saveReaderTlPinned,
  saveTlHistory,
  translationSavedToast,
  upsertTlEntry,
  type GlossaryEntry,
  type ReaderTranslateResult,
  type TlHistoryEntry,
} from "../reader";
import ReaderTranslatePanel, {
  type TlPending,
} from "./ReaderTranslatePanel";
import ReaderTlFloat from "./ReaderTlFloat";
import type { SessionLinkState, TabStatus } from "../pages/TerminalPage";

// Monaco 与 pdf.js 都不进主包：首次进入阅读区才加载（同终端页预览的懒加载姿势）
const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));
const PdfContinuousView = lazy(() => import("./PdfContinuousView"));

/** ensure_paper_note 的返回（notes/<slug>.md 建档：已存在原样返回，永不覆盖） */
interface PaperNoteDto {
  path: string;
  created: boolean;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 文献标题 = 文件名 stem（顶栏《》用） */
function stemOf(p: string): string {
  return basename(p).replace(/\.pdf$/i, "");
}

/** 顶栏图标钮（‹ › 收起/展开侧栏共用样式） */
const topBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1";

/**
 * 沉浸式阅读区：全屏覆盖层，三栏「笔记 | PDF | Agent 终端」。
 * 挂在终端页内（fixed inset-0 z-40 页面模态档），Esc 退出；底下终端/PTY/右栏全程保持挂载。
 * 右栏 = 阅读会话标签的真实 xterm 画面：宿主 DOM 由 TerminalPage 搬进 termSlot 槽位
 * （Monaco 宿主移动同款先例，PTY/scrollback 不重建）；会话起停/注入也在 TerminalPage。
 */
export default function ReaderOverlay({
  pdfPath,
  projectRoot,
  notePath,
  hasAgentTab,
  agentTabId,
  agentStatus,
  agentSession,
  needsProfile,
  onInject,
  onRestartAgent,
  onGoProfiles,
  onClose,
  termSlot,
  statusBarSlot,
}: {
  pdfPath: string;
  projectRoot: string;
  /** 指定笔记（精读笔记产物入口）：笔记栏直接编辑该 md，不按 PDF slug 另建模板笔记 */
  notePath?: string | null;
  /** 阅读会话标签是否还在（在但没上报状态 = 正在启动；不在 = 被手动关掉） */
  hasAgentTab: boolean;
  /** 阅读会话标签 id（遮面重启触发器：每次新派必变，关掉重进/重新启动都重新挂遮面） */
  agentTabId: string | null;
  /** 阅读会话标签状态（还没建起/未上报为 null） */
  agentStatus: TabStatus | null;
  /** 会话联动数据（状态行的关联状态点用；与终端页右栏同一来源） */
  agentSession: SessionLinkState | null;
  /** 没有任何可用配置：右栏显示引导卡 */
  needsProfile: boolean;
  /** 写入阅读会话 PTY（send=true 补 \r 直接发送；缺省写进终端输入行，用户看着回车）；
      返回 null 成功，否则为提示 */
  onInject: (
    data: string,
    send?: boolean,
  ) => string | null | Promise<string | null>;
  /** 阅读会话标签被关掉后的「重新启动」（清空一次性标记让 TerminalPage 再派一次） */
  onRestartAgent: () => void;
  onGoProfiles: () => void;
  onClose: () => void;
  /** 右栏 xterm 宿主槽位的回调 ref（TerminalPage 负责把该标签的容器节点搬进来/搬回去） */
  termSlot: (el: HTMLDivElement | null) => void;
  /** 右栏底部终端状态栏槽位的回调 ref（同一标签的 TerminalStatusBar 节点，随宿主一起搬） */
  statusBarSlot: (el: HTMLDivElement | null) => void;
}) {
  const stem = stemOf(pdfPath);
  const macFullscreen = useMacFullscreen(IS_MAC);

  // Esc 退出（阅读区优先于专注模式等退出：TerminalPage 的专注 Esc 在阅读区打开时不拦）；
  // isComposing 守卫：中文输入法组词中按 Esc 是取消候选，不关阅读区。
  // 口径（与终端页专注模式同语义）：焦点在右栏 xterm 里时 Esc 被 xterm 就地消化
  // （打断生成/vim 等），不会冒泡到这里——要退出用「← 返回」或先点别处再 Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ⌘E（Win/Linux Ctrl+E）翻转笔记栏阅读/编辑：组合判定走 hotkeys 纯逻辑，
  // 经 modeTick 信号递进通知 FilePreviewEditor（tick/signal 先例：TerminalPage readerAgentTick）。
  // 焦点在右栏 xterm 里时不拦（Ctrl+E 是 readline 行尾；与 Esc 级联「键归终端」同语义，
  // mac 下 ⌘E 对终端无语义，但统一按焦点规则跳过最稳）
  const [noteModeTick, setNoteModeTick] = useState(0);
  const rightColRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!eventMatchesCombo(e, READER_MODE_HOTKEY)) return;
      if (rightColRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      setNoteModeTick((t) => t + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ===== 侧栏收起与分隔条拖拽（宽度百分比记 localStorage） =====
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  /** 滑动进行中（过渡配方只在这个窗口内挂上）：收起态下栏宽会随窗口缩放/对侧
   *  分隔条拖拽逐帧变——margin 目标每帧变而过渡常开时，CSS 从插值中点重定向，
   *  收起侧整段拖拽过程外宽≠0、露出一条空底。过完渡即摘类，此后栏宽变化瞬时生效
   *  （元素 invisible，无视觉参与）。transitionend 提前收口，定时器兜底 */
  const [leftSlide, setLeftSlide] = useState(false);
  const [rightSlide, setRightSlide] = useState(false);
  useEffect(() => {
    if (!leftSlide && !rightSlide) return;
    const t = setTimeout(() => {
      setLeftSlide(false);
      setRightSlide(false);
    }, 260); // 200ms 过渡 + 余量；连点重定向后过渡会跑满新时长，
    // open 态进依赖让每次翻转重臂定时器，避免中途到期把过渡掐断
    return () => clearTimeout(t);
  }, [leftSlide, rightSlide, leftOpen, rightOpen]);
  const [pctL, setPctL] = useState(() =>
    loadReaderPct(READER_SPLIT_L_KEY, READER_PCT_DEFAULT_L),
  );
  const [pctR, setPctR] = useState(() =>
    loadReaderPct(READER_SPLIT_R_KEY, READER_PCT_DEFAULT_R),
  );
  const areaRef = useRef<HTMLDivElement>(null);
  // 初始值直接取窗口宽（覆盖层恒为全窗口宽）：避免首帧按 0 渲染成只剩 PDF 栏的闪帧
  const [areaW, setAreaW] = useState(() => window.innerWidth);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    setAreaW(el.clientWidth);
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { left: leftPx, right: rightPx } = readerColumnWidths(areaW, pctL, pctR);
  // 极端窄窗（PDF 保底都拿不出）时换算结果为 0：侧栏整栏让位，只留 PDF。
  // 平时收起/展开不卸载——整块（栏 + 分隔条）负 margin 滑出（readerPanelSlideMargin），
  // 栏宽不变 → Monaco/xterm 宿主零重排零搬移，PDF 栏重排由其停稳防抖收口
  const mountLeft = leftPx > 0;
  const mountRight = rightPx > 0;

  /** 分隔条拖拽（仿终端页 startSplitResize 的 pointer 模式；松手才落 localStorage） */
  function startSideResize(
    side: "left" | "right",
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const setPct = side === "left" ? setPctL : setPctR;
    const key = side === "left" ? READER_SPLIT_L_KEY : READER_SPLIT_R_KEY;
    const fallback = side === "left" ? pctL : pctR;
    const pctOf = (clientX: number) =>
      clampReaderPct(
        side === "left"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((rect.right - clientX) / rect.width) * 100,
        fallback,
      );
    const onMove = (moveEvent: PointerEvent) => setPct(pctOf(moveEvent.clientX));
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalPct = pctOf(upEvent.clientX);
      setPct(finalPct);
      localStorage.setItem(key, String(Math.round(finalPct)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  const splitter = (side: "left" | "right") => (
    <div
      onPointerDown={(e) => startSideResize(side, e)}
      style={{ width: READER_SPLITTER_PX }}
      className="group relative shrink-0 cursor-col-resize"
    >
      {/* 平时透明极细（w-0.5），悬停才显色（终端页同款手法）；外层热区宽走
          READER_SPLITTER_PX（与收起滑出量同源，reader.ts 单一出处） */}
      <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
    </div>
  );

  // ===== 笔记栏：打开即建档（已存在原样返回），嵌入 FilePreviewEditor =====
  const [note, setNote] = useState<PaperNoteDto | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  /** 笔记栏内相对链接点开的文件（null = 显示本篇笔记）；「← 回笔记」退回 */
  const [noteViewPath, setNoteViewPath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setNoteError(null);
    setNoteViewPath(null);
    // 指定笔记（精读笔记产物入口）：直接用它，跳过 ensure 建档——
    // 否则会按 PDF slug 再建一份模板笔记，与 lit-notes 的 <序号-短标题>.md 并存打架
    if (notePath) {
      setNote({ path: notePath, created: false });
      return () => {
        cancelled = true;
      };
    }
    invoke<PaperNoteDto>("ensure_paper_note", { projectRoot, pdfPath })
      .then((dto) => {
        if (!cancelled) setNote(dto);
      })
      .catch((e) => {
        if (!cancelled) setNoteError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, pdfPath, notePath]);

  /** 笔记栏编辑态脏标记（FilePreviewEditor onDirtyChange 上报）：保存译段/插入图片成功后
      的 toast 口径要用——dirty 时 watcher 停订，界面不会回显刚写入的内容 */
  const [noteDirty, setNoteDirty] = useState(false);

  // ===== 右栏启动占位（2026-09-20）：退出即关标签后，每次进入都新派 CLI 会话——
  // 头几帧标签还没建出来（hasAgentTab=false，不能闪「阅读会话未在运行」引导卡），
  // 起来后到 CLI 开屏出字前 xterm 也是一段黑底。两段都用占位盖住，超时兜底回落真状态 */
  /** 期待会话标签出现（mount / 点「重新启动会话」置 true；标签出现即清，4s 兜底） */
  const [expectAgent, setExpectAgent] = useState(true);
  useEffect(() => {
    if (hasAgentTab) setExpectAgent(false);
  }, [hasAgentTab]);
  useEffect(() => {
    if (!expectAgent) return;
    const t = setTimeout(() => setExpectAgent(false), 4000);
    return () => clearTimeout(t);
  }, [expectAgent]);
  /** 会话联动出现前的黑屏遮面（会话文件落盘 ≈ TUI 已开屏；8s 兜底防个别 CLI 联动不到）；
      重启触发器 = 会话标签 id：关掉旧标签 reopen 后旧 startedAt 会原样带回来，
      以 startedAt 为触发器不会重新挂遮面（裸黑 xterm 露出来），标签 id 是每次新派必变的 */
  const [sessionVeil, setSessionVeil] = useState(true);
  useEffect(() => {
    setSessionVeil(true);
  }, [agentTabId]);
  useEffect(() => {
    if (!sessionVeil) return;
    if (agentSession) {
      setSessionVeil(false);
      return;
    }
    const t = setTimeout(() => setSessionVeil(false), 8000);
    return () => clearTimeout(t);
  }, [sessionVeil, agentSession]);

  // ===== 护眼、toast、生词本、翻译（结果都在 PDF 栏浮卡就地呈现，没有工具页签） =====

  /** 护眼反色（按文件记忆；只反 PDF canvas 层，文字层保持主题色） */
  const [readerDark, setReaderDark] = useState(() => loadReaderDark(pdfPath));

  /** 轻量 toast（保存译段/生词本结果；右下角浮出 2.5s 淡出，GitPanel 同款节奏） */
  const [toast, setToast] = useState<{ text: string; ok: boolean; hiding: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(text: string, ok = true) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, ok, hiding: false });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2500);
  }
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // 换文献：护眼记忆按文件重读
  useEffect(() => {
    setReaderDark(loadReaderDark(pdfPath));
  }, [pdfPath]);

  function toggleDark() {
    setReaderDark((v) => {
      saveReaderDark(pdfPath, !v);
      return !v;
    });
  }

  // 生词本：阅读区打开时加载一次（术语高亮数据源），增删后随返回值刷新
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<GlossaryEntry[]>("list_glossary", { projectRoot })
      .then((list) => {
        if (!cancelled) setGlossary(list);
      })
      .catch(() => {
        /* 生词本读取失败不打断阅读：高亮退化为空表 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  /** 翻译统一入口（ai_prompt fnKey="translate"）：纯文本输出（bilingual 模式已随块级
      对照改版下线）；面板翻译的状态机见下方 runTranslate，生词预填直接用本函数 */
  const requestTranslate = useCallback(
    async (text: string): Promise<ReaderTranslateResult> => {
      if (needsProfile) return { ok: false, error: "还没有可用的 API 配置" };
      try {
        const zh = await invoke<string>("ai_prompt", {
          profileId: null,
          fnKey: "translate",
          prompt: buildReaderTranslatePrompt(text),
        });
        return { ok: true, text: zh.trim() };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    [needsProfile],
  );

  // ===== 翻译面板（原位 = 右栏状态行之下、xterm 之上；钉住 = 悬浮 PDF 正文栏右下）：
  // 历史/pending 状态上提自 PdfContinuousView，下栏只留触发（选段「译」/ ⌘+点击段落
  // → onTranslate）。localStorage 键不变，另加钉位键 =====
  /** 翻译面板高度占比（% 右栏总高）：null = 内容自适应（40% 封顶，未拖过）；拖过底缘分割条后
      显式高度并记忆（同左右分栏口径），双击分割条复位自适应 */
  const [tlPct, setTlPct] = useState<number | null>(() =>
    loadReaderTlPct(READER_SPLIT_T_KEY),
  );
  /** 译文卡「钉在 PDF 上」（跨收起/展开、跨次进入都保持悬浮球形态）；有效悬浮 = 钉住
   *  OR 右栏收起/让位（兜底：终端栏收着时译文有地方看，展开即回原位，无需提前钉） */
  const [tlPinned, setTlPinned] = useState(() => loadReaderTlPinned());
  const tlFloat = tlPinned || !mountRight || !rightOpen;
  const [tlHistory, setTlHistory] = useState<TlHistoryEntry[]>([]);
  const [tlPending, setTlPending] = useState<TlPending | null>(null);
  const [tlSaving, setTlSaving] = useState(false);
  /** 连点/连触只认最后一次；× 收起时递增作废在途结果 */
  const tlReqRef = useRef(0);

  // 换文献：重读该文件的历史并清在途态
  useEffect(() => {
    setTlHistory(loadTlHistory(pdfPath));
    setTlPending(null);
  }, [pdfPath]);

  // 悬浮会话内「新翻译落地/失败/在途开始」递进信号：球自动展开（译完即见；
  // 失败也要弹——球关着时错误落地球里静默等于动作失灵）。只认变化不认存量
  const [tlOpenTick, setTlOpenTick] = useState(0);
  const tlSeenRef = useRef<{
    at: string | null;
    pending: boolean;
    err: boolean;
  } | null>(null);
  useEffect(() => {
    if (!tlFloat) {
      tlSeenRef.current = null;
      tlStartOpenRef.current = false; // 钉住接续标记只在本次悬浮会话生效
      return;
    }
    const at = tlHistory[0]?.at ?? null;
    const pending = tlPending !== null;
    const err = tlPending?.phase === "error";
    const prev = tlSeenRef.current;
    tlSeenRef.current = { at, pending, err };
    if (!prev) return; // 进入悬浮态第一拍只建基线
    if (
      (at !== null && at !== prev.at) ||
      (pending && !prev.pending) ||
      (err && !prev.err)
    ) {
      setTlOpenTick((t) => t + 1);
    }
  }, [tlFloat, tlHistory, tlPending]);

  /** 面板翻译主链路：在途态 → 纯文本翻译 → 成功入历史（同原文替换置顶）。
      写盘放在 setState updater 里：StrictMode 双跑写同样内容，幂等无副作用 */
  const runTranslate = useCallback(
    async (text: string, page: number) => {
      const my = ++tlReqRef.current;
      setTlPending({ text, page, phase: "loading" });
      const r = await requestTranslate(text);
      if (my !== tlReqRef.current) return;
      if (r.ok) {
        setTlPending(null);
        setTlHistory((prev) => {
          const next = upsertTlEntry(prev, {
            original: text,
            translated: r.text,
            page,
            saved: false,
            at: new Date().toISOString(),
          });
          saveTlHistory(pdfPath, next);
          return next;
        });
      } else {
        setTlPending({ text, page, phase: "error", error: r.error });
      }
    },
    [requestTranslate, pdfPath],
  );


  /** 保存译段到笔记「## 译段」（笔记栏 watcher 自动刷新） */
  const saveTranslation = useCallback(
    async (t: {
      original: string;
      translated: string;
      page: number;
    }): Promise<string | null> => {
      if (!note) return "笔记还没建好，稍等片刻再试";
      try {
        await invoke("append_note_translation", {
          projectRoot,
          notePath: note.path,
          original: t.original,
          translated: t.translated,
          page: t.page,
        });
        // 笔记栏 dirty（编辑态有未保存改动）时 watcher 停订不回显，文案里明说（口径纯函数在 reader.ts）
        showToast(translationSavedToast(noteDirty));
        return null;
      } catch (e) {
        const msg = `译段保存失败：${String(e)}`;
        showToast(msg, false);
        return msg;
      }
    },
    [note, noteDirty, projectRoot],
  );

  /** 「存进笔记」：走既有 saveTranslation 链路（toast 与笔记栏回显口径都在里面），
      成功后给条目打上持久 saved 标记；旧的对照格式条目只存纯译文（兼容 shim）；
      原文/译文都先 reflow（PDF 断词断行不进笔记；译段格式不变：原文引用行 + 纯译文） */
  const saveTlEntry = useCallback(
    async (entry: TlHistoryEntry) => {
      if (entry.saved || tlSaving) return;
      setTlSaving(true);
      const pairs = parseBilingual(entry.translated);
      const err = await saveTranslation({
        original: reflowBlockText(entry.original, { cjk: false }),
        translated: reflowBlockText(
          pairs ? plainFromBilingual(pairs) : entry.translated,
          { cjk: true },
        ),
        page: entry.page,
      });
      setTlSaving(false);
      if (err) return; // 失败文案已由 saveTranslation toast 透出
      setTlHistory((prev) => {
        const next = markTlEntrySaved(prev, entry.original);
        saveTlHistory(pdfPath, next);
        return next;
      });
    },
    [saveTranslation, tlSaving, pdfPath],
  );

  const addGlossary = useCallback(
    async (
      term: string,
      meaning: string,
      source: string,
    ): Promise<string | null> => {
      try {
        const list = await invoke<GlossaryEntry[]>("append_glossary", {
          projectRoot,
          term,
          meaning,
          source,
        });
        setGlossary(list);
        showToast("已加入生词本");
        return null;
      } catch (e) {
        return `写入生词本失败：${String(e)}`;
      }
    },
    [projectRoot],
  );

  // ===== Agent 栏（右栏 = 终端画面）：选段/截图注入写阅读会话 PTY（文字出现在终端输入行里，正好可见） =====

  /** PDF 选段「◈ 问 AI」：格式出处后注入（缺省不发送；↵ 直接发送 send=true） */
  const askAiFromPdf = useCallback(
    (text: string, page: number, fileName: string, send?: boolean) =>
      onInject(formatPdfExcerptPrompt(text, page, fileName), send),
    [onInject],
  );

  // ===== Agent 上下文简报：阅读会话是项目级复用的普通会话，拉起时不带阅读上下文，
  // 用户说「这篇」「笔记」它不知道指什么。note 就绪且会话在跑时一次性直发简报
  // （按 note.path 去重；换 PDF → note.path 变 → 重新简报；发送失败不标记，
  // 下次 running 跃迁重试）。已知竞态：send=true 会把用户输入行里未发完的文字
  // 一起带出去（注入语义如此），agentStatus.running 守门后窗口极小，接受。
  const briefedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!note || !agentStatus?.running) return;
    if (briefedRef.current === note.path) return;
    void Promise.resolve(
      onInject(
        `【阅读上下文】我在沉浸阅读区读 PDF：${pdfPath}；配套笔记：${note.path}。之后我说「这篇」「笔记」都指它们；要改笔记就直接编辑这个文件。`,
        true,
      ),
    ).then((err) => {
      if (!err) briefedRef.current = note.path;
    });
  }, [note, agentStatus?.running, pdfPath, onInject]);

  // ===== 圈选截图去向（批次 B2）：裁好的 PNG 由 PdfContinuousView 交来 =====

  /** ◈ 发给 agent：落剪贴板临时图（终端粘贴图片同一命令/口径）→ 路径 + 预填 prompt 写进终端输入行，不自动发送 */
  const captureToAgent = useCallback(
    async (blob: Blob, page: number, fileName: string): Promise<string | null> => {
      if (needsProfile) return "还没有可用的 API 配置";
      if (!hasAgentTab) return "阅读会话未在运行";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const absPath = await invoke<string>("save_clipboard_image", {
          bytes: Array.from(bytes),
          ext: "png",
        });
        return onInject(formatReaderCapturePrompt(absPath, page, fileName, IS_WINDOWS), false);
      } catch (e) {
        return `截图发送准备失败：${String(e)}`;
      }
    },
    [needsProfile, hasAgentTab, onInject],
  );

  /** ＋ 插入笔记：落 notes/assets/ → 追加进「## 我的想法」；笔记栏经 watcher 自动刷新可见 */
  const captureToNote = useCallback(
    async (blob: Blob): Promise<string | null> => {
      if (!note) return "笔记还没建好，稍等片刻再试";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const cap = await invoke<{ relPath: string; absPath: string }>(
          "save_reader_capture",
          { projectRoot, imageBase64: bytesToBase64(bytes) },
        );
        await invoke("append_note_image", {
          projectRoot,
          notePath: note.path,
          relImagePath: cap.relPath,
        });
        return null;
      } catch (e) {
        return `贴进笔记失败：${String(e)}`;
      }
    },
    [note, projectRoot],
  );

  // ===== 顶栏 tooltip（应用内 HoverTip，禁原生 title） =====
  const backRef = useRef<HTMLButtonElement>(null);
  const backTip = useHoverTip(backRef);
  const leftRef = useRef<HTMLButtonElement>(null);
  const leftTip = useHoverTip(leftRef);
  const rightRef = useRef<HTMLButtonElement>(null);
  const rightTip = useHoverTip(rightRef);
  const darkRef = useRef<HTMLButtonElement>(null);
  const darkTip = useHoverTip(darkRef);
  const gestureRef = useRef<HTMLSpanElement>(null);
  const gestureTip = useHoverTip(gestureRef);

  // ===== Agent 栏顶部状态行：agent 名 · 模型 · 启动中/运行中状态点（终端页同语义） =====
  const agentName = agentStatus
    ? (AGENTS.find((a) => a.id === agentStatus.agentId)?.label ??
      agentStatus.agentId)
    : null;
  const agentModel = agentStatus?.model?.trim();
  const agentRunning = agentStatus?.running ?? false;
  const agentStateText = agentRunning
    ? "运行中"
    : agentStatus?.startedAt
      ? "未在运行"
      : "启动中…";

  /** 表头「钉住/回栏」：钉住落记忆键（跨收起/展开、跨次进入保持悬浮）；回栏 = 取钉
      并确保右栏展开——右栏收着时点回栏就是「把侧栏叫回来接住面板」，不让它无声消失。
      从看得见的卡点钉住时球先展开接续（卡搬家，不是缩成球）；该标记只在本次悬浮
      会话生效，兜底档（收起右栏自动出球）仍收着球起步 */
  const tlStartOpenRef = useRef(false);
  function toggleTlPlacement() {
    if (tlFloat) {
      setTlPinned(false);
      saveReaderTlPinned(false);
      // 回栏顺手展开右栏要带滑入过渡（与顶栏按钮同款成对翻转，否则瞬跳）
      if (!rightOpen) {
        setRightOpen(true);
        setRightSlide(true);
      }
    } else {
      tlStartOpenRef.current = true;
      setTlPinned(true);
      saveReaderTlPinned(true);
    }
  }

  // 翻译面板两档摆位共用一套 props；摆位差异只在 heightPct（% 右栏高，悬浮档恒 null）
  const tlPanelProps = {
    latest: tlHistory[0] ?? null,
    pending: tlPending,
    history: tlHistory,
    saving: tlSaving,
    canSave: true,
    onTogglePlacement: toggleTlPlacement,
    onResize: setTlPct,
    onResizeEnd: (pct: number) => {
      setTlPct(pct);
      localStorage.setItem(READER_SPLIT_T_KEY, String(Math.round(pct)));
    },
    onResizeReset: () => {
      setTlPct(null);
      localStorage.removeItem(READER_SPLIT_T_KEY);
    },
    onRetry: (text: string, page: number) => void runTranslate(text, page),
    onCancelPending: () => {
      tlReqRef.current++;
      setTlPending(null);
    },
    onSaveEntry: (e: TlHistoryEntry) => void saveTlEntry(e),
    onHint: showToast,
    canAsk: Boolean(hasAgentTab),
    onAsk: (entry: TlHistoryEntry) => {
      const pairs = parseBilingual(entry.translated);
      const text = reflowBlockText(
        pairs ? plainFromBilingual(pairs) : entry.translated,
        { cjk: true },
      );
      // 右栏收着时注入进看不见的终端＝动作看似失灵：顺手带滑入过渡展开右栏
      // （回栏同款口径），让文字落在看得见的输入行里
      if (!mountRight || !rightOpen) {
        setRightOpen(true);
        setRightSlide(true);
      }
      // 注入失败（CLI 已退出等）要把提示亮出来，不能无声无息
      void Promise.resolve(
        onInject(
          `这段译文在第 ${entry.page} 页：\n${text}\n请对照原文指出译得不准或漏掉的地方。`,
          false,
        ),
      ).then((hint) => {
        if (hint) showToast(hint);
      });
    },
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas">
      {/* 40px 顶栏：← 返回（Esc 同效）/ 《文献标题》/ 收起左右栏。
          覆盖层会盖住 App 的自绘标题栏，此条必须自己承担两件事（口径同 App.tsx 顶栏）：
          可拖动 + macOS Overlay 红绿灯让位（窗口态 pl-[78px]，全屏收起按钮后取消让位）。
          拖拽用手动 startDragging 而非 data-tauri-drag-region：属性版只认 mousedown 落点的
          元素本尊，这条栏几乎全被按钮/标题子元素占满，实测拖不动；手动版拦交互元素即可 */}
      <div
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, a, input, select, textarea"))
            return;
          void getCurrentWindow()
            .startDragging()
            .catch(() => {});
        }}
        className={`flex h-10 shrink-0 items-center gap-1 border-b border-hairline pr-2 ${macOverlayPadClass(
          IS_MAC,
          macFullscreen,
          "pl-2",
        )}`}
      >
        <button
          ref={backRef}
          type="button"
          aria-label="返回文档"
          onMouseEnter={backTip.show}
          onMouseLeave={backTip.hide}
          onClick={onClose}
          className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
        >
          ← 返回
        </button>
        <span className="min-w-0 flex-1 truncate px-2 text-center text-sm text-l1">
          《{stem}》
        </span>
        <button
          ref={darkRef}
          type="button"
          aria-label={readerDark ? "关闭护眼反色" : "开启护眼反色"}
          onMouseEnter={darkTip.show}
          onMouseLeave={darkTip.hide}
          onClick={toggleDark}
          className={`${topBtn} ${readerDark ? "bg-seg-sel text-l1" : ""}`}
        >
          ◐
        </button>
        <span
          ref={gestureRef}
          onMouseEnter={gestureTip.show}
          onMouseLeave={gestureTip.hide}
          className="flex h-7 w-7 shrink-0 cursor-help items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l2"
        >
          ?
        </span>
        <button
          ref={leftRef}
          type="button"
          aria-label={leftOpen ? "收起左侧笔记栏" : "展开左侧笔记栏"}
          onMouseEnter={leftTip.show}
          onMouseLeave={leftTip.hide}
          onClick={() => {
            setLeftOpen((v) => !v);
            setLeftSlide(true);
          }}
          className={topBtn}
        >
          {leftOpen ? "‹" : "›"}
        </button>
        <button
          ref={rightRef}
          type="button"
          aria-label={rightOpen ? "收起右侧对话栏" : "展开右侧对话栏"}
          onMouseEnter={rightTip.show}
          onMouseLeave={rightTip.hide}
          onClick={() => {
            setRightOpen((v) => !v);
            setRightSlide(true);
          }}
          className={topBtn}
        >
          {rightOpen ? "›" : "‹"}
        </button>
        <HoverTip tip={backTip.tip} text="退出沉浸阅读（Esc；焦点在终端里时 Esc 归终端）" />
        <HoverTip
          tip={darkTip.tip}
          text={readerDark ? "关闭护眼反色" : "护眼反色（按文件记忆）"}
        />
        <HoverTip
          tip={gestureTip.tip}
          text="⌘/Ctrl + 点击正文段落：整段对照翻译"
        />
        <HoverTip
          tip={leftTip.tip}
          text={leftOpen ? "收起笔记栏" : "展开笔记栏"}
        />
        <HoverTip
          tip={rightTip.tip}
          text={rightOpen ? "收起终端栏" : "展开终端栏"}
        />
      </div>

      {/* 三栏区：笔记 | PDF | Agent 终端（侧栏收起 = 整块滑出，拖拽条记百分比）。
          侧栏块常挂载：收起用负 margin 滑出窗口外（过渡配方 ccode-reader-panel
          只在滑动窗口内挂——见 leftSlide 注释），栏宽全程不变——笔记 Monaco 与右栏
          xterm 宿主不重排不搬移（slot ref 稳定，TerminalPage 的搬移只在覆盖层
          开/关、标签更替时发生）；visibility 参与过渡：收起滑完才隐、展开起点即显，
          收起态不可聚焦不可 Tab */}
      <div ref={areaRef} className="flex min-h-0 flex-1">
        {mountLeft && (
          <div
            style={{ marginLeft: readerPanelSlideMargin(leftPx, leftOpen) }}
            onTransitionEnd={(e) => {
              if (e.target !== e.currentTarget) return; // 子元素过渡不冒充本栏
              if (e.propertyName.startsWith("margin")) setLeftSlide(false);
            }}
            className={`flex shrink-0 ${leftSlide ? "ccode-reader-panel" : ""} ${
              leftOpen ? "" : "invisible"
            }`}
          >
            <div
              style={{ width: leftPx }}
              className="flex min-w-0 shrink-0 flex-col border-r border-hairline bg-rail2"
            >
                {noteError ? (
                  <div className="p-3">
                    <p className="text-xs text-err-text">
                      笔记建档失败：{noteError}
                    </p>
                  </div>
                ) : !note ? (
                  <div className="p-3">
                    <LoadingRows compact />
                  </div>
                ) : (
                  <Suspense
                    fallback={
                      <div className="p-3">
                        <LoadingRows compact />
                      </div>
                    }
                  >
                    {/* 文件名/阅读⇄编辑切换沿用 FilePreviewEditor 自带工具条（不重复画一行）；
                        hideImmersive：它自己的 ⛶ 沉浸层是 z-30，压在阅读区 z-40 下面会失灵；
                        onOpenFile：md 相对链接在笔记栏原地打开（previewReq 会开在阅读区底下看不见） */}
                    {noteViewPath && noteViewPath !== note.path && (
                      <div className="flex h-7 shrink-0 items-center border-b border-hairline px-2">
                        <button
                          type="button"
                          onClick={() => setNoteViewPath(null)}
                          className="rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                        >
                          ← 回笔记
                        </button>
                      </div>
                    )}
                    <FilePreviewEditor
                      path={noteViewPath ?? note.path}
                      root={projectRoot}
                      hideImmersive
                      onOpenFile={setNoteViewPath}
                      modeTick={noteModeTick}
                      onDirtyChange={setNoteDirty}
                    />
                  </Suspense>
                )}
            </div>
            {splitter("left")}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="p-3">
                <LoadingRows compact />
              </div>
            }
          >
            <PdfContinuousView
              path={pdfPath}
              cwdHint={projectRoot}
              onAskAi={askAiFromPdf}
              onBack={onClose}
              onCaptureAgent={captureToAgent}
              onCaptureNote={captureToNote}
              glossTerms={glossary}
              dark={readerDark}
              onRequestTranslate={requestTranslate}
              onTranslate={(text, page) => void runTranslate(text, page)}
              onAddGlossary={addGlossary}
            />
          </Suspense>
        </div>

        {mountRight && (
          <div
            style={{ marginRight: readerPanelSlideMargin(rightPx, rightOpen) }}
            onTransitionEnd={(e) => {
              if (e.target !== e.currentTarget) return; // 子元素过渡不冒充本栏
              if (e.propertyName.startsWith("margin")) setRightSlide(false);
            }}
            className={`flex shrink-0 ${rightSlide ? "ccode-reader-panel" : ""} ${
              rightOpen ? "" : "invisible"
            }`}
          >
            {splitter("right")}
            <div
              ref={rightColRef}
              style={{ width: rightPx }}
              className="flex min-w-0 shrink-0 flex-col border-l border-hairline bg-raised"
            >
                {/* 状态行：状态点 + agent 名 · 模型 + 启动中/运行中（终端页同语义）。
                    下方就是该阅读会话标签的 xterm 画面（宿主 DOM 搬移，PTY/scrollback 不动） */}
                {/* 翻译面板在上，自成一张卡。下面的对话另起一张，中间留出栏底。
                    钉住档 / 右栏收起时不在此渲染——同一张卡悬浮到 PDF 正文栏（见 PDF 栏） */}
                {!tlFloat && (
                  <ReaderTranslatePanel {...tlPanelProps} heightPct={tlPct} />
                )}
                {needsProfile ? (
                  // 无可用配置：引导卡（一句话 + 跳配置页）
                  <div className="mx-2 mb-2 mt-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-field bg-canvas p-4 text-center">
                    <p className="text-sm text-l3">还没有可用的 API 配置</p>
                    <button
                      type="button"
                      onClick={onGoProfiles}
                      className="rounded-md border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110"
                    >
                      去配置页添加
                    </button>
                  </div>
                ) : !hasAgentTab ? (
                  expectAgent ? (
                    // 标签还在派的路上：别把「阅读会话未在运行」闪一下（错误状态早于真实状态）
                    <div className="mx-2 mb-2 mt-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-field bg-canvas p-4 text-center">
                      <span className="size-2 animate-pulse rounded-full bg-l3" />
                      <p className="text-sm text-l3">正在启动 Agent…</p>
                    </div>
                  ) : (
                    // 阅读会话标签被手动关掉：给个重新拉起的入口（不连环自动重建）
                    <div className="mx-2 mb-2 mt-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-field bg-canvas p-4 text-center">
                      <p className="text-sm text-l3">阅读会话未在运行</p>
                      <button
                        type="button"
                        onClick={() => {
                          setExpectAgent(true);
                          onRestartAgent();
                        }}
                        className="rounded-md border border-field bg-strip px-3 py-1.5 text-sm text-l2 hover:bg-inset hover:text-l1"
                      >
                        重新启动会话
                      </button>
                    </div>
                  )
                ) : (
                  // xterm 宿主槽 + 底部状态栏槽：TerminalPage 把阅读会话标签的终端容器节点
                  // 与 TerminalStatusBar 节点一并搬进来，阅读区关闭时搬回原标签
                  // （栏收起只是滑出隐藏，槽位常驻不搬；DOM 搬移不重建，
                  // 滚动缓冲与状态栏内部状态不丢）。
                  // 根不 overflow-hidden：状态栏向上弹出的模型/工作目录菜单要伸出卡外。
                  // 卡面走全局 .ccode-well 配方（内容卡），不再自拼 border-field+bg-canvas
                  <div className="ccode-well mx-2 mb-2 mt-2 flex min-h-0 flex-1 flex-col rounded-lg">
                    <div className="flex h-8 shrink-0 items-center gap-2 rounded-t-[7px] border-b border-hairline bg-strip px-2.5 text-micro">
                      <span
                        className={`size-2 shrink-0 rounded-full ${
                          agentRunning
                            ? "bg-ok-text"
                            : agentSession?.state === "timeout"
                              ? "bg-warn-text"
                              : "bg-l4"
                        }`}
                      />
                      <span className="text-l2">对话</span>
                      <span className="min-w-0 truncate text-l4">
                        {needsProfile
                          ? "还没有配置"
                          : `${agentName ?? "Agent"}${agentModel ? ` · ${agentModel}` : ""} · ${agentStateText}`}
                      </span>
                    </div>
                    <div
                      ref={termSlot}
                      className="relative flex min-h-0 flex-1 flex-col"
                    >
                      {/* CLI 开屏遮面：会话联动出现（≈TUI 已开屏）前盖住 xterm 黑底；
                          搬移是 appendChild，遮面作为槽位孩子与宿主共存 */}
                      {sessionVeil && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-raised">
                          <span className="size-2 animate-pulse rounded-full bg-l3" />
                          <p className="text-sm text-l3">
                            正在启动 {agentName ?? "Agent"}…
                          </p>
                        </div>
                      )}
                    </div>
                    <div
                      ref={statusBarSlot}
                      className="shrink-0 border-t border-hairline"
                    />
                  </div>
                )}
            </div>
          </div>
        )}
      </div>

      {tlFloat && (
        // 译文悬浮档（钉住显式声明，或右栏收起时的兜底）：挂覆盖层根——坐标域是
        // 整窗，右栏/笔记栏展开时球也拖得到窗口边缘（挂 PDF 栏会被栏界挡住）。
        // 拖动状态留在球组件内，不惊动三栏树
        <ReaderTlFloat
          panelProps={tlPanelProps}
          hasContent={Boolean(tlHistory[0] || tlPending)}
          openTick={tlOpenTick}
          startOpen={tlStartOpenRef.current}
        />
      )}

      {/* 保存译段/生词本结果 toast：右下角浮出 2.5s 淡出（✓/✗ 语义色小标） */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-hairline ccode-float-surface px-3 py-2 text-sm text-l1 transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span className={toast.ok ? "text-ok-text" : "text-err-text"}>
            {toast.ok ? "✓" : "✗"}
          </span>
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}
