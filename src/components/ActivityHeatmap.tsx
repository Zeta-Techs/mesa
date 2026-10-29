import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  UsageActivityAgentsDto,
  UsageActivityDayDto,
  UsageActivityDto,
  UsageDayAgentRowDto,
  UsageDayDetailDto,
} from "../types";
import { AGENTS } from "../types";
import { compact, fmtCost, sessionDisplayTitle } from "../stats-insight";
import { agentBrand } from "../agent-colors";
import { useAppStore } from "../store";
import {
  activityDatePhrase,
  activeMainDays,
  buildRollingGrid,
  HEAT_CELL_MAX_PX,
  HEAT_WELL_PAD_PX,
  heatCellPx,
  levelOf,
  levelThresholds,
  mainTokens,
  shiftDay,
  streaks,
  rollingBounds,
  weekdayIndex,
  yearStats,
} from "../usage-activity";
import { InlineNotice } from "./PageFrame";

/** 星期槽显一/三/五/七（隔行标注，2026-10-12 用户拍板加周日）；周几信息由每格 aria-label 承载 */
const WEEKDAY_VISIBLE = new Set([0, 2, 4, 6]);
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;
const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

interface TipState {
  day: string;
  /** 格子锚点几何（fixed 定位 + portal，横向滚动容器裁不到） */
  left: number;
  top: number;
  bottom: number;
  below: boolean;
}

interface PopState {
  day: string;
  left: number;
  top: number;
  bottom: number;
  below: boolean;
  /** 打开时按所选方向的可用空间算好的高度上限：浮层不越出视口，内容在层内滚 */
  maxH: number;
  detail: UsageDayDetailDto | null;
  loading: boolean;
  failed: boolean;
}

/**
 * 用量页「活跃度」区块：去年同月到今天的热力图 + 按 agent 筛选 + 点格下钻。
 * 独立时间窗（去年同月 1 日到今天，不翻页），不跟随页顶 range；数据一次拉全
 * 历史非零日序列，窗口 / streak / 「显示内部活动」开关全部本地推导，零重查。
 * 挂载在页面 empty 三元之外：页面级空态是 range 口径，历史有数据的用户
 * 恰恰要在空 range 下看到这张图。
 * 口径：着色/活跃/streak 恒只算非 internal（official 计入）；着色量=四类合计。
 */
export default function ActivityHeatmap({
  visible,
  currency,
  rate,
  showInternal,
  refreshKey,
}: {
  visible: boolean;
  currency: "$" | "¥";
  rate: number;
  showInternal: boolean;
  refreshKey: number;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSessionScopeReq = useAppStore((s) => s.setSessionScopeReq);
  const sessions = useAppStore((s) => s.sessions);

  const [dto, setDto] = useState<UsageActivityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [agentsMatrix, setAgentsMatrix] = useState<UsageActivityAgentsDto | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [pop, setPop] = useState<PopState | null>(null);
  const seq = useRef(0);
  const agentsSeq = useRef(0);
  const measureRef = useRef<HTMLDivElement>(null);
  /** 布局只跟页面满宽哨兵走（始终 100%，与主区是否 hug 无关）。单模布局
   *  （2026-10-16 拍板）：胶囊全在卡头一行、主区无左栏，格子 11–28px 正方形
   *  吃满卡宽；28 只是地砖闸，到顶后主区收成内容宽居中、卡片保持列宽对齐兄弟卡。
   *  容器查询在本环境不稳，ResizeObserver 确定性写入 */
  const [cellPx, setCellPx] = useState(11);
  const weeksRef = useRef(53);
  const tableRef = useRef<HTMLTableElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const detailCache = useRef(new Map<string, UsageDayDetailDto>());

  /** 冷启动兜底的自动补拉只许一次：事件→补拉→若仍超预算又发事件会自激成环
   *  （2026-10-15 实证烧满后端），这里每个「旧数周期」最多自动补拉一回；
   *  拿到非 refreshing 的新数后复位，下个周期（如再进页）重新计一次 */
  const autoRefetchedRef = useRef(false);

  const reloadDto = useCallback(() => {
    const s = ++seq.current;
    setLoading(true);
    invoke<UsageActivityDto>("usage_activity")
      .then((res) => {
        if (s !== seq.current) return;
        setDto(res);
        setError(null);
        if (!res.refreshing) autoRefetchedRef.current = false;
      })
      .catch((e) => {
        if (s === seq.current) setError(String(e));
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    // 数据即将重拉（进页/回页/页级刷新）：日详情缓存随之作废，已开的浮层一并关闭
    detailCache.current.clear();
    setPop(null);
    if (!visible) return;
    reloadDto();
  }, [visible, refreshKey, reloadDto]);

  // 冷启动兜底（2026-10-15）：后端重建超预算先回了旧数（refreshing）时，后台索引
  // 刷完发这个事件——在页且本周期还没自动补拉过才补一次，图几秒内自动变新；
  // 不在页由 visible 效果兜底。补拉后若仍 refreshing，本周期不再自动补（防环）
  useEffect(() => {
    if (!visible) return;
    let unlisten: (() => void) | undefined;
    listen("usage-activity-refreshed", () => {
      if (autoRefetchedRef.current) return;
      autoRefetchedRef.current = true;
      reloadDto();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [visible, reloadDto]);

  const today = dto?.today ?? "";
  const bounds = useMemo(
    () => (dto ? rollingBounds(dto.today) : null),
    [dto],
  );
  const endYear = dto ? Number(dto.today.slice(0, 4)) : 0;

  // 窗口跨两个自然年，年矩阵接口一次只给一年：两年都拉，按今年的排序拼起来
  useEffect(() => {
    if (!visible || !dto) return;
    const s = ++agentsSeq.current;
    const y = Number(dto.today.slice(0, 4));
    Promise.all([
      invoke<UsageActivityAgentsDto>("usage_activity_agents", { year: y - 1 }),
      invoke<UsageActivityAgentsDto>("usage_activity_agents", { year: y }),
    ])
      .then(([prev, cur]) => {
        if (s !== agentsSeq.current) return;
        const seen = new Set<string>();
        const agents: string[] = [];
        for (const name of [...cur.agents, ...prev.agents]) {
          if (seen.has(name)) continue;
          seen.add(name);
          agents.push(name);
        }
        const byDay = new Map<string, UsageActivityAgentsDto["days"][number]["byAgent"]>();
        for (const part of [prev, cur]) {
          for (const row of part.days) {
            const list = byDay.get(row.day) ?? [];
            list.push(...row.byAgent);
            byDay.set(row.day, list);
          }
        }
        const days = [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([day, byAgent]) => ({ day, byAgent }));
        setAgentsMatrix({ year: y, agents, days });
      })
      .catch(() => {
        if (s === agentsSeq.current) setAgentsMatrix(null);
      });
  }, [visible, refreshKey, dto]);

  useEffect(() => {
    // 矩阵缺席（拉取失败）视同全量口径：选中中的胶囊必须被放下，
    // 否则 agentDayMap 恒空 → 整图空白且无「全部」入口可回
    if (!agentsMatrix || !agentsMatrix.agents.includes(selectedAgent ?? "")) {
      setSelectedAgent(null);
    }
  }, [agentsMatrix, selectedAgent]);

  const grid = useMemo(
    () => (dto ? buildRollingGrid(dto.today) : null),
    [dto],
  );
  if (grid) weeksRef.current = grid.weeks.length;
  const hasChips =
    agentsMatrix?.year === endYear && (agentsMatrix?.agents.length ?? 0) >= 2;

  useEffect(() => {
    const track = measureRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    let cell = 11;
    const sync = () => {
      const inner = Math.max(0, track.clientWidth - HEAT_WELL_PAD_PX);
      const nextCell = heatCellPx(inner, weeksRef.current);
      if (nextCell === cell) return;
      // 格子边长变了，开着的浮层锚定坐标全部作废，一并关掉
      cell = nextCell;
      setCellPx(nextCell);
      setTip(null);
      setPop(null);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(track);
    return () => ro.disconnect();
    // dto 为 null 的首帧不渲染主区（早退骨架），数据到了哨兵出现时才挂观察器；
    // dto 重拉（今天跨周）会让周列数变化，哨兵宽度可能不变、观察器不响，也要重算
  }, [dto]);
  const dayMap = useMemo(() => {
    const m = new Map<string, UsageActivityDayDto>();
    if (dto) for (const d of dto.days) m.set(d.day, d);
    return m;
  }, [dto]);
  const agentDayMap = useMemo(() => {
    const m = new Map<string, Map<string, UsageDayAgentRowDto>>();
    if (agentsMatrix && agentsMatrix.year === endYear) {
      for (const day of agentsMatrix.days) {
        m.set(
          day.day,
          new Map(day.byAgent.map((r) => [r.agent, r])),
        );
      }
    }
    return m;
  }, [agentsMatrix, endYear]);

  /** 两年矩阵已就位（拉取失败不算——此时回落全局口径，避免整图闪空白） */
  const matrixReady = agentsMatrix?.year === endYear;

  /** 格子取数：选了 agent 按该 agent 当日量（没有即 0 档空槽），否则全局 main 量 */
  function cellInfo(day: string): { value: number; sessions: number; has: boolean } {
    if (selectedAgent && matrixReady) {
      const row = agentDayMap.get(day)?.get(selectedAgent);
      return {
        value: row?.tokens ?? 0,
        sessions: row?.sessions ?? 0,
        has: Boolean(row),
      };
    }
    const d = dayMap.get(day);
    const has = Boolean(d && d.sessions >= 1);
    return { value: has ? mainTokens(d!) : 0, sessions: d?.sessions ?? 0, has };
  }

  /** 分档阈值恒用当前口径的非零值：切胶囊/开关不引起档位定义漂移外的跳变 */
  const thresholds = useMemo(() => {
    if (!grid) return null;
    const vals: number[] = [];
    for (const col of grid.weeks) {
      for (const g of col) {
        if (!g) continue;
        const c = cellInfo(g.day);
        if (c.has) vals.push(c.value);
      }
    }
    return levelThresholds(vals);
    // cellInfo 依赖 selectedAgent/agentDayMap/dayMap/matrixReady，显式列出
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, selectedAgent, agentDayMap, dayMap, matrixReady]);
  const stats = useMemo(() => {
    if (!dto || !grid) return null;
    const b = bounds ?? rollingBounds(dto.today);
    if (selectedAgent && matrixReady) {
      // 胶囊口径：活跃/峰值/连续都按该 agent 在这一窗口的量算
      let activeDays = 0;
      let peakTokens = 0;
      let peakDay: string | null = null;
      const active = new Set<string>();
      for (const day of agentDayMap.keys()) {
        const row = agentDayMap.get(day)!.get(selectedAgent);
        if (!row) continue;
        if (day < b.start || day > b.end) continue;
        active.add(day);
        activeDays++;
        if (row.tokens > peakTokens) {
          peakTokens = row.tokens;
          peakDay = day;
        }
      }
      return { activeDays, peakTokens, peakDay, streak: streaks(active, dto.today) };
    }
    return {
      ...yearStats(dto.days, b.start, b.end),
      streak: streaks(activeMainDays(dto.days), dto.today),
    };
  }, [dto, grid, bounds, selectedAgent, agentDayMap, matrixReady]);
  /** roving tabindex 初始停靠点：今天 */
  const initialFocusDay = useMemo(() => {
    if (!grid || !dto) return null;
    const b = bounds ?? rollingBounds(dto.today);
    if (dto.today >= b.start && dto.today <= b.end) return dto.today;
    let last: string | null = null;
    for (const d of dto.days) {
      if (d.sessions >= 1 && d.day >= b.start && d.day <= b.end) last = d.day;
    }
    return last ?? b.end;
  }, [grid, dto, bounds]);
  const focusTarget = focusDay ?? initialFocusDay;

  const popOpen = pop !== null;
  const tipOpen = tip !== null;

  function closeTip() {
    setTip(null);
  }
  function closePop(silent = false) {
    const day = pop?.day;
    setPop(null);
    if (!silent && day) {
      tableRef.current
        ?.querySelector<HTMLTableCellElement>(`td[data-day="${day}"]`)
        ?.focus();
    }
  }

  // 浮层随滚动/缩放关闭：tooltip 全关；日详情浮层内滚（会话列表）不关
  useEffect(() => {
    if (!tipOpen && !popOpen) return;
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      closeTip();
      if (popOpen) closePop(true);
    };
    const onResize = () => {
      closeTip();
      if (popOpen) closePop(true);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipOpen, popOpen]);

  // Esc / 浮层外点击关闭日详情
  useEffect(() => {
    if (!popOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePop();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (popRef.current?.contains(t)) return;
      if (t.closest?.("td[data-day]")) return; // 点另一格 = 换详情，不当作「外部关闭」
      closePop(true);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popOpen]);

  function rectOf(td: Element) {
    const r = td.getBoundingClientRect();
    return {
      left: r.left + r.width / 2,
      top: r.top,
      bottom: r.bottom,
      below: r.top < window.innerHeight * 0.35,
    };
  }

  function showTipAt(td: Element, day: string) {
    if (!cellInfo(day).has) return; // 零日无信息，不出悬浮（GitHub 同口径）
    setTip({ day, ...rectOf(td) });
  }

  function onPointerOver(e: ReactPointerEvent<HTMLDivElement>) {
    const td = (e.target as Element).closest("td[data-day]");
    if (!td) return;
    const day = td.getAttribute("data-day");
    if (!day || tip?.day === day) return;
    showTipAt(td, day);
  }

  /** 键盘焦点触发同一悬浮：费用/订阅/内部注记不只活在 hover 里 */
  function onFocusCell(e: ReactFocusEvent<HTMLTableElement>) {
    const td = (e.target as Element).closest("td[data-day]");
    if (!td) return;
    const day = td.getAttribute("data-day");
    if (!day) return;
    setFocusDay(day);
    if (tip?.day !== day) showTipAt(td, day);
  }

  async function openDetail(day: string, td: Element) {
    if (pop?.day === day) {
      closePop();
      return;
    }
    const r = td.getBoundingClientRect();
    // 上下两个方向谁的可用空间大朝谁开；高度钳进实际空间（不再固定 70vh 顶出屏）
    const availBelow = window.innerHeight - r.bottom - 16;
    const availAbove = r.top - 16;
    const below = availBelow >= availAbove;
    const maxH = Math.max(
      220,
      Math.min(window.innerHeight * 0.7, below ? availBelow : availAbove),
    );
    const rect = rectOf(td);
    const cached = detailCache.current.get(day);
    setPop({ day, ...rect, below, maxH, detail: cached ?? null, loading: !cached, failed: false });
    if (cached === undefined) {
      try {
        const detail = await invoke<UsageDayDetailDto>("usage_day_detail", { day });
        detailCache.current.set(day, detail);
        setPop((p) => (p?.day === day ? { ...p, detail, loading: false } : p));
      } catch {
        setPop((p) =>
          p?.day === day ? { ...p, loading: false, failed: true } : p,
        );
      }
    }
  }

  function jumpToSession(agent: string, sessionId: string) {
    closePop(true);
    setOpenSessionReq({ agent, sessionId });
    setPage("sessions");
  }

  function jumpToDayScope() {
    if (!pop) return;
    const label = `${Number(pop.day.slice(5, 7))}月${Number(pop.day.slice(8, 10))}日`;
    setSessionScopeReq({ kind: "day", value: pop.day, label });
    setPage("sessions");
    closePop(true);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTableElement>) {
    if (!grid || !dto) return;
    const td = (e.target as Element).closest("td[data-day]");
    if (!td) return;
    const day = td.getAttribute("data-day");
    if (!day) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void openDetail(day, td);
      return;
    }
    const b = bounds ?? rollingBounds(dto.today);
    const clamp = (d: string) => (d < b.start ? b.start : d > b.end ? b.end : d);
    const ctrl = e.ctrlKey || e.metaKey;
    let target: string;
    if (e.key === "ArrowLeft") target = shiftDay(day, -1);
    else if (e.key === "ArrowRight") target = shiftDay(day, 1);
    else if (e.key === "ArrowUp") target = shiftDay(day, -7);
    else if (e.key === "ArrowDown") target = shiftDay(day, 7);
    else if (e.key === "Home" && ctrl) target = b.start;
    else if (e.key === "End" && ctrl) target = b.end;
    else if (e.key === "Home") target = shiftDay(day, -weekdayIndex(day));
    else if (e.key === "End") target = shiftDay(day, 6 - weekdayIndex(day));
    else if (e.key === "PageUp")
      target = shiftDay(b.start, (weekdayIndex(day) - weekdayIndex(b.start) + 7) % 7);
    else if (e.key === "PageDown")
      target = shiftDay(b.end, -((weekdayIndex(b.end) - weekdayIndex(day) + 7) % 7));
    else return;
    e.preventDefault();
    const next = clamp(target);
    if (next === day) return;
    setFocusDay(next);
    tableRef.current
      ?.querySelector<HTMLTableCellElement>(`td[data-day="${next}"]`)
      ?.focus();
  }

  // 全库无用量：区块不渲染（页面级空态由 stats 判定，本区块只认自己的 firstDay）
  if (!dto) {
    if (error) {
      return (
        <section className="mt-8" aria-label="活跃度">
          <h2 className="flex min-h-9 items-center border-b border-hairline pb-2 text-lg font-semibold text-l1">活跃度</h2>
          <p className="mt-2 text-xs text-warn-text">活跃度加载失败：{error}</p>
        </section>
      );
    }
    if (loading) {
      return (
        <section className="mt-8" aria-label="活跃度">
          <h2 className="flex min-h-9 items-center border-b border-hairline pb-2 text-lg font-semibold text-l1">活跃度</h2>
          <div
            className="mt-3 h-28 w-full animate-pulse rounded-md bg-inset"
            role="status"
            aria-label="活跃度加载中"
          />
        </section>
      );
    }
    return null;
  }
  if (!dto.firstDay || !grid || !thresholds || !stats) return null;

  const tipCell = tip ? cellInfo(tip.day) : null;
  const tipDay = tip ? dayMap.get(tip.day) : null;
  const tipExtras: string[] = [];
  if (tipDay) {
    if (selectedAgent) tipExtras.push(`全部 ${compact(mainTokens(tipDay))} tokens`);
    if (tipDay.costUsd == null) tipExtras.push("花费 ~");
    else if (tipDay.costUsd > 0)
      tipExtras.push(`花费 ${fmtCost(tipDay.costUsd, currency, rate, tipDay.costPartial)}`);
    if (tipDay.officialTokens > 0) tipExtras.push(`订阅 ${compact(tipDay.officialTokens)}`);
    if (showInternal && tipDay.internalTokens > 0)
      tipExtras.push(`内部 ${compact(tipDay.internalTokens)}`);
  }
  const peakSuffix = stats.peakDay
    ? `${Number(stats.peakDay.slice(5, 7))}月${Number(stats.peakDay.slice(8, 10))}日`
    : "";
  const chips = hasChips && agentsMatrix ? agentsMatrix.agents : [];

  const statsLine = (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs tabular-nums text-l3">
          <span
            title={
              selectedAgent
                ? `这一窗口内 ${agentLabel(selectedAgent)} 有用量的天数`
                : "这一窗口内有非内部用量的天数（订阅用量计入）"
            }
          >
            活跃 {stats.activeDays} 天
          </span>
          <span aria-hidden="true" className="text-l4">·</span>
          <span
            title={
              selectedAgent
                ? `这一窗口内 ${agentLabel(selectedAgent)} 连续有活动的天数；今天还没记录不清零`
                : "截至今日或昨日连续有活动的天数（全部历史，跨年不断档）；今天还没记录不清零"
            }
          >
            连续 {stats.streak.current} 天
          </span>
          <span aria-hidden="true" className="text-l4">·</span>
          <span
            title={
              selectedAgent
                ? `这一窗口内 ${agentLabel(selectedAgent)} 最长的一段连续活跃`
                : "全部历史里最长的一段连续活跃（跨年不断档）"
            }
          >
            最长 {stats.streak.longest} 天
          </span>
          <span aria-hidden="true" className="text-l4">·</span>
          <span
            title={`这一窗口单日四类 token 合计最高的一天${peakSuffix ? `（${peakSuffix}）` : ""}`}
          >
            峰值 {compact(stats.peakTokens)}
            {peakSuffix ? `（${peakSuffix}）` : ""}
          </span>
        </p>
  );


  const hug = cellPx >= HEAT_CELL_MAX_PX;

  return (
    // 2026-10-29 用量页借鉴 Claude 设置页：节标题粗体、标题行下一根细线，不再套卡
    <div className="mt-8">
    <div
      ref={measureRef}
      className="h-0 w-full overflow-hidden"
      aria-hidden="true"
    />
    <section
      className={hug ? "ccode-heat-hug" : undefined}
      aria-label="活跃度"
    >
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline pb-2">
        <div className="flex shrink-0 items-baseline gap-2">
          <h2
            className="text-lg font-semibold text-l1"
            title="从去年同一个月的 1 日铺到今天（本机时区归日），最右边是今天。格子与四个数含订阅用量、不含 Mesa 内部活动；页顶「显示内部活动」只在悬浮和当日明细里追加注记，不改变格子颜色和统计。着色量为输入+输出+缓存读写四类合计，与页首 tokens 卡（只计输入+输出）口径不同。"
          >
            活跃度
          </h2>
          {dto.stale && (
            <span className="text-micro text-warn-text">索引刷新失败，显示上次统计</span>
          )}
        </div>
        {chips.length > 0 && (
          <div
            className="ccode-heat-agents ccode-seg-boxed is-sm"
            role="group"
            aria-label="按 agent 筛选"
          >
            {[
              { id: null as string | null, label: "全部" },
              ...chips.map((a) => ({ id: a as string | null, label: agentLabel(a) })),
            ].map((chip) => {
              const active = selectedAgent === chip.id;
              return (
                <button
                  key={chip.id ?? "all"}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedAgent(chip.id)}
                  title={
                    chip.id === "codebuddy" || chip.id === "cursor"
                      ? `${chip.label}（该 agent 的用量字段尚未完全实证，数据可能偏薄）`
                      : chip.label
                  }
                  className="ccode-seg-boxed-item flex items-center gap-1.5 text-xs"
                >
                  {chip.id && (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: agentBrand(chip.id) }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 truncate">{chip.label}</span>
                </button>
              );
            })}
          </div>
        )}
        {bounds && (
          <span className="ml-auto shrink-0 text-xs tabular-nums text-l3">
            {`${bounds.start.slice(0, 4)}.${bounds.start.slice(5, 7)} – ${bounds.end.slice(0, 4)}.${bounds.end.slice(5, 7)}`}
          </span>
        )}
      </div>

      <div className="ccode-heat-main">
      <div
        className="ccode-heat-grid"
        onPointerOver={onPointerOver}
        onPointerLeave={closeTip}
        onClick={(e) => {
          const td = (e.target as Element).closest("td[data-day]");
          if (td) void openDetail(td.getAttribute("data-day")!, td);
        }}
      >
        <table
          ref={tableRef}
          role="grid"
          aria-label={`${bounds?.start ?? ""} 至 ${today} 每日用量热力图，共 ${grid.dayCount} 天，活跃 ${stats.activeDays} 天。方向键移动，回车查看当日明细。`}
          className="ccode-heat"
          style={
            {
              "--heat-weeks": grid.weeks.length,
              "--heat-cell": `${cellPx}px`,
            } as CSSProperties
          }
          onKeyDown={onKeyDown}
          onFocus={onFocusCell}
        >
          <tbody>
            {grid.weeks[0].map((_, row) => (
              <tr key={row}>
                <th className="ccode-heat-weekday" aria-hidden="true" scope="row">
                  {WEEKDAY_VISIBLE.has(row) ? WEEKDAY_LABELS[row] : ""}
                </th>
                {grid.weeks.map((col, ci) => {
                  const g = col[row];
                  if (!g) return <td key={ci} />;
                  const c = cellInfo(g.day);
                  const lv = c.has ? levelOf(c.value, thresholds) : 0;
                  const who = selectedAgent ? agentLabel(selectedAgent) : "";
                  const label = c.has
                    ? `${activityDatePhrase(g.day, today)}，${who ? `${who} ` : ""}${c.sessions} 个对话，共 ${compact(c.value)} tokens`
                    : `${activityDatePhrase(g.day, today)}，无用量`;
                  const cls = [
                    c.has ? "ccode-heat-on" : "",
                    g.day === today ? "ccode-heat-today" : "",
                    pop?.day === g.day ? "ccode-heat-sel" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <td
                      key={ci}
                      data-day={g.day}
                      role="gridcell"
                      aria-label={label}
                      tabIndex={g.day === focusTarget ? 0 : -1}
                      className={cls || undefined}
                    >
                      <span className={`ccode-heat-cell ccode-heat-l${lv}`} data-level={lv} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td aria-hidden="true" />
              {(() => {
                const cells = [];
                let mi = 0;
                for (let ci = 0; ci < grid.weeks.length; ci++) {
                  const mark = grid.monthMarks[mi];
                  if (mark && mark.weekIndex === ci) {
                    cells.push(
                      <td key={ci} className="ccode-heat-month" colSpan={mark.span}>
                        {mark.label}
                      </td>,
                    );
                    ci += mark.span - 1;
                    mi++;
                  } else {
                    cells.push(<td key={ci} className="ccode-heat-month" aria-hidden="true" />);
                  }
                }
                return cells;
              })()}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="ccode-heat-foot">
        {statsLine}
        <span
          className="ccode-heat-scale shrink-0"
          title="颜色按所选范围内有用量的日子相对分档，越深当天用量越大"
          aria-label="色阶：颜色越深当天用量越大"
        >
          <span className="text-micro text-l4">少</span>
          {[0, 1, 2, 3, 4].map((lv) => (
            <span
              key={lv}
              className={`ccode-heat-swatch ccode-heat-l${lv}`}
              data-level={lv}
            />
          ))}
          <span className="text-micro text-l4">多</span>
        </span>
      </div>
      </div>

      {tip &&
        tipCell?.has &&
        createPortal(
          <div
            role="tooltip"
            className="ccode-float-surface pointer-events-none fixed z-50 max-w-72 rounded-md border border-hairline px-2.5 py-1.5 text-left"
            style={{
              left: `${Math.min(Math.max(tip.left, 150), window.innerWidth - 150)}px`,
              top: tip.below ? `${tip.bottom + 8}px` : `${tip.top - 8}px`,
              transform: tip.below
                ? "translateX(-50%)"
                : "translateX(-50%) translateY(-100%)",
            }}
          >
            <div className="text-xs text-l2">{activityDatePhrase(tip.day, today)}</div>
            <div className="font-mono text-xs tabular-nums text-l1">
              {compact(tipCell.value)} tokens · {tipCell.sessions} 个对话
              {selectedAgent ? ` · ${agentLabel(selectedAgent)}` : ""}
            </div>
            {tipExtras.length > 0 && (
              <div className="text-micro text-l4">{tipExtras.join(" · ")}</div>
            )}
          </div>,
          document.body,
        )}

      {pop &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-modal="false"
            aria-label={`${activityDatePhrase(pop.day, today)} 用量明细`}
            tabIndex={-1}
            className="ccode-float-surface fixed z-60 overflow-y-auto rounded-lg border border-hairline p-4 text-left outline-none"
            style={{
              left: `${Math.min(
                Math.max(pop.left - 208, 12),
                Math.max(12, window.innerWidth - 428),
              )}px`,
              top: pop.below ? `${pop.bottom + 8}px` : undefined,
              bottom: pop.below
                ? undefined
                : `${Math.max(8, window.innerHeight - pop.top + 8)}px`,
              maxHeight: `${pop.maxH}px`,
              width: "min(26rem, calc(100vw - 24px))",
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") closePop();
            }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-l1">
                {activityDatePhrase(pop.day, today)}
              </span>
              <span className="text-micro text-l4">
                {pop.detail ? `${pop.detail.totals.sessions} 个对话` : ""}
              </span>
            </div>
            {pop.loading && (
              <div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-l4/50" role="status" />
            )}
            {pop.failed && (
              <InlineNotice tone="warn" className="mt-2">当日明细加载失败，请稍后再试。</InlineNotice>
            )}
            {pop.detail && (
              <>
                <div className="mt-2 break-all font-mono text-micro tabular-nums text-l3">
                  输入 {compact(pop.detail.totals.input)} · 输出{" "}
                  {compact(pop.detail.totals.output)} · 缓存读{" "}
                  {compact(pop.detail.totals.cacheRead)} · 缓存写{" "}
                  {compact(pop.detail.totals.cacheWrite)}
                </div>
                <div className="mt-0.5 text-xs tabular-nums text-l2">
                  {pop.detail.totals.costUsd != null && pop.detail.totals.costUsd > 0
                    ? `花费 ${fmtCost(pop.detail.totals.costUsd, currency, rate, pop.detail.totals.costPartial)}`
                    : pop.detail.totals.costUsd == null
                      ? "花费 ~"
                      : "订阅日 · 无可计费用量"}
                  {pop.detail.totals.officialTokens > 0 &&
                    ` · 订阅 ${compact(pop.detail.totals.officialTokens)}`}
                  {showInternal && pop.detail.totals.internalTokens > 0 &&
                    ` · 内部 ${compact(pop.detail.totals.internalTokens)}`}
                </div>
                {pop.detail.byAgent.length > 0 && (
                  <div className="mt-3 flex flex-col gap-1.5">
                    {(() => {
                      const rows = pop.detail.byAgent.slice(0, 3);
                      const rest = pop.detail.byAgent
                        .slice(3)
                        .reduce((n, r) => n + r.tokens, 0);
                      const all = rest > 0 ? [...rows, { agent: "其他", tokens: rest, sessions: 0 }] : rows;
                      const max = Math.max(...all.map((r) => r.tokens), 1);
                      return all.map((r) => (
                        <div key={r.agent} className="flex items-center gap-2 text-xs text-l2">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: agentBrand(r.agent) }}
                            aria-hidden="true"
                          />
                          <span className="min-w-[76px] shrink-0">
                            {r.agent === "其他" ? "其他" : agentLabel(r.agent)}
                            {selectedAgent === r.agent ? " ·" : ""}
                          </span>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-inset">
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${Math.round((r.tokens / max) * 100)}%`,
                                background: agentBrand(r.agent),
                              }}
                            />
                          </span>
                          <span className="min-w-[52px] shrink-0 text-right font-mono text-micro tabular-nums text-l3">
                            {compact(r.tokens)}
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
                {(() => {
                  const list = pop.detail.sessions.filter((s) => showInternal || !s.internal);
                  return list.length > 0 ? (
                    <div className="mt-3 flex flex-col gap-0.5">
                      {list.slice(0, 8).map((s) => {
                        const scanned = sessions.find(
                          (x) => x.agent === s.agent && x.sessionId === s.sessionId,
                        );
                        const title = sessionDisplayTitle({
                          customTitle: s.title,
                          scannedTitle: scanned?.customTitle ?? scanned?.title,
                          sessionId: s.sessionId,
                        });
                        return (
                          <button
                            key={`${s.agent}-${s.sessionId}`}
                            type="button"
                            onClick={() => jumpToSession(s.agent, s.sessionId)}
                            title="打开结构化会话视图"
                            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover"
                          >
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ background: agentBrand(s.agent) }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate text-xs text-l2">
                              {title}
                              {s.internal && (
                                <span className="ml-1.5 text-micro text-l4">内部</span>
                              )}
                            </span>
                            {s.official && (
                              <span className="shrink-0 text-micro text-l4">订阅</span>
                            )}
                            <span className="shrink-0 font-mono text-micro tabular-nums text-l4">
                              {compact(s.tokens)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null;
                })()}
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline pt-2.5">
                  <span className="text-micro text-l4" title="对话页按会话最近更新时间归日；格子按当日用量事件归日，跨天的长会话可能出现在相邻两天">
                    按会话最近更新时间归日
                  </span>
                  <button
                    type="button"
                    className="h-7 shrink-0 rounded-sm px-1 text-xs text-l3 hover:text-l1"
                    onClick={jumpToDayScope}
                  >
                    在对话页看这天 →
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </section>
    </div>
  );
}
