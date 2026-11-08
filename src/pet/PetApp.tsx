/**
 * 桌宠小窗（desk_pet.rs 建、pet.html 入口；设计稿 docs/design-desk-pet.md）。
 * 只画小桌、数字角标、冒的一句话和点开的「等你的事」小卡片；清单由主窗口发来（desk-pet:feed），
 * 点的事发回主窗口原路办（desk-pet:act），「去看看」经 desk_pet_open 叫回主窗口跳过去。
 * 小窗平时只有小桌那么大（不挡桌面），冒话 / 点开时临时变大，小桌在屏幕上的位置不动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import MesaBuddy from "../components/MesaBuddy";
import { buddyDayPart, buddyMood } from "../buddy-time";
import { isLightTheme } from "../themes";
import {
  arrivalReaction,
  bubbleText,
  newArrivals,
  petKindLabel,
  petPose,
  pickBubble,
  waitingCount,
  type PetFeed,
  type PetItem,
  type PetOpen,
  type PetSay,
} from "../desk-pet";

type Size = "small" | "normal" | "large";
const PET_PX: Record<Size, number> = { small: 80, normal: 112, large: 144 };
const PAD = 12;
const PANEL_W = 320;
const BUBBLE_H = 96;
const LIST_H = 400;
const BUBBLE_MS = 8000;
const DND_KEY = "ccode.deskPet.dndUntil";
const SEEN_KEY = "ccode.deskPet.seen";

interface PetSettings {
  theme?: string;
  deskPetSay?: PetSay;
  deskPetSize?: Size;
}

type Panel = { kind: "bubble"; item: PetItem; count: number } | { kind: "list" } | null;

function readDnd(): number {
  const v = Number(localStorage.getItem(DND_KEY) ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export default function PetApp() {
  const win = useMemo(() => getCurrentWindow(), []);
  const [settings, setSettings] = useState<PetSettings>({});
  const [feed, setFeed] = useState<PetFeed>({ working: false, items: [] });
  const [panel, setPanel] = useState<Panel>(null);
  const [reaction, setReaction] = useState<"oops" | "happy" | null>(null);
  const [drag, setDrag] = useState<"left" | "right" | null>(null);
  const [dndUntil, setDndUntil] = useState(readDnd);
  const [hour, setHour] = useState(() => new Date().getHours());
  // 上一轮的键：比对新来的；第一次（null）不冒话。存本机，重开小窗不把旧事当新事再冒一遍
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      seen.current = raw ? new Set(JSON.parse(raw) as string[]) : null;
    } catch {
      seen.current = null;
    }
  }
  const size: Size = settings.deskPetSize ?? "normal";
  const pet = PET_PX[size];
  const compact = pet + PAD * 2;
  const light = isLightTheme(settings.theme);

  const loadSettings = useCallback(async () => {
    const s = await invoke<PetSettings>("get_settings").catch(() => ({}) as PetSettings);
    setSettings(s);
  }, []);

  // 收清单、比新来的、冒话与反应
  const sayRef = useRef<PetSay>("important");
  sayRef.current = settings.deskPetSay ?? "important";
  const dndRef = useRef(dndUntil);
  dndRef.current = dndUntil;
  useEffect(() => {
    let off: (() => void) | null = null;
    let offSettings: (() => void) | null = null;
    void loadSettings();
    void listen<PetFeed>("desk-pet:feed", (e) => {
      const next = e.payload;
      const arrivals = newArrivals(seen.current, next.items);
      seen.current = new Set(next.items.map((i) => i.key));
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-400)));
      } catch {
        /* 记不下最多重冒一次 */
      }
      setFeed(next);
      const quiet = Date.now() < dndRef.current;
      if (!quiet && arrivals.length) {
        const r = arrivalReaction(arrivals);
        if (r) {
          setReaction(r);
          window.setTimeout(() => setReaction(null), r === "oops" ? 2600 : 1400);
        }
        const pick = pickBubble(arrivals, sayRef.current);
        if (pick) setPanel((p) => (p?.kind === "list" ? p : { kind: "bubble", item: pick, count: arrivals.length }));
      }
    }).then((u) => (off = u));
    void listen("desk-pet:settings", () => void loadSettings()).then((u) => (offSettings = u));
    // 告诉主窗口小窗起来了，马上发一份清单
    void emitTo("main", "desk-pet:ready", null);
    const tick = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => {
      off?.();
      offSettings?.();
      window.clearInterval(tick);
    };
  }, [loadSettings]);

  // 冒的话 8 秒后自己收起（鼠标停在上面时不收）
  const hovering = useRef(false);
  useEffect(() => {
    if (panel?.kind !== "bubble") return;
    const t = window.setTimeout(() => {
      if (!hovering.current) setPanel((p) => (p?.kind === "bubble" ? null : p));
    }, BUBBLE_MS);
    return () => window.clearTimeout(t);
  }, [panel]);

  // 小窗大小跟着面板走：平时只有小桌那么大；冒话 / 点开时往上、往屏幕里侧长，小桌在屏幕上不动
  const home = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<Panel>(panel);
  panelRef.current = panel;
  const [layout, setLayout] = useState<{ side: "left" | "right"; below: boolean }>({ side: "right", below: false });
  const resizing = useRef(false);
  useEffect(() => {
    let stale = false;
    void (async () => {
      const sf = await win.scaleFactor();
      const pos = (await win.outerPosition()).toLogical(sf);
      // 小桌的「家」只在第一次和拖完时记：收起面板时窗口还是展开的大小，这时读位置会把面板左上角当成家，小桌跳走
      //（2026-11-09 用户：「点事项面板的关闭 位置会乱动」）
      if (!home.current) home.current = { x: pos.x, y: pos.y };
      const h0 = home.current;
      resizing.current = true;
      if (!panel) {
        await win.setSize(new LogicalSize(compact, compact));
        await win.setPosition(new LogicalPosition(h0.x, h0.y));
      } else {
        const W = Math.max(PANEL_W, compact);
        const H = compact + (panel.kind === "bubble" ? BUBBLE_H : LIST_H);
        const mon = await currentMonitor();
        const area = mon ? { x: mon.workArea.position.toLogical(mon.scaleFactor).x, y: mon.workArea.position.toLogical(mon.scaleFactor).y, w: mon.workArea.size.toLogical(mon.scaleFactor).width, h: mon.workArea.size.toLogical(mon.scaleFactor).height } : null;
        // 小桌在屏幕右半边：面板往左长；在左半边往右长。上面放不下就放到小桌下面
        const side = area && h0.x + compact / 2 < area.x + area.w / 2 ? "left" : "right";
        const below = !!area && h0.y + compact - H < area.y;
        const x = side === "right" ? h0.x + compact - W : h0.x;
        const y = below ? h0.y : h0.y + compact - H;
        if (!stale) setLayout({ side, below });
        await win.setSize(new LogicalSize(W, H));
        await win.setPosition(new LogicalPosition(x, y));
      }
      // 系统报「窗口移动了」可能晚到：留够时间，免得把自己挪窗口当成人在拖
      window.setTimeout(() => (resizing.current = false), 600);
    })();
    return () => {
      stale = true;
    };
  }, [panel, compact, win]);

  // 拖着走：按下移动超过 4px 交给系统拖窗口；移动方向决定往左还是往右走；停下 300ms 记位置
  const down = useRef<{ x: number; y: number } | null>(null);
  const lastX = useRef<number | null>(null);
  const stopTimer = useRef(0);
  useEffect(() => {
    let off: (() => void) | null = null;
    void win
      .onMoved(({ payload }) => {
        // 面板开着时不能拖（onPetMove 挡了），这时的移动都是展开 / 收起自己挪的
        if (resizing.current || panelRef.current) return;
        const prev = lastX.current;
        lastX.current = payload.x;
        if (prev !== null && Math.abs(payload.x - prev) > 1) setDrag(payload.x < prev ? "left" : "right");
        window.clearTimeout(stopTimer.current);
        stopTimer.current = window.setTimeout(async () => {
          setDrag(null);
          lastX.current = null;
          const sf = await win.scaleFactor();
          const pos = payload.toLogical(sf);
          home.current = { x: pos.x, y: pos.y };
          void invoke("desk_pet_save_position", { x: pos.x, y: pos.y }).catch(() => {});
        }, 300);
      })
      .then((u) => (off = u));
    return () => off?.();
  }, [win]);

  function onPetDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    down.current = { x: e.screenX, y: e.screenY };
  }
  function onPetMove(e: React.MouseEvent) {
    const d = down.current;
    if (!d || panel) return;
    if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 4) {
      down.current = null;
      void win.startDragging();
    }
  }
  function onPetUp(e: React.MouseEvent) {
    if (e.button !== 0 || !down.current) return;
    down.current = null;
    setPanel((p) => (p?.kind === "list" ? null : { kind: "list" }));
  }

  async function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const dnd = Date.now() < dndUntil;
    const menu = await Menu.new({
      items: [
        { id: "open", text: "打开 Mesa", action: () => void invoke("desk_pet_open", { target: null }) },
        {
          id: "dnd",
          text: dnd ? "结束勿扰" : "勿扰一小时",
          action: () => {
            const until = dnd ? 0 : Date.now() + 3_600_000;
            localStorage.setItem(DND_KEY, String(until));
            setDndUntil(until);
            if (!dnd) setPanel(null);
          },
        },
        { id: "settings", text: "桌宠设置…", action: () => void invoke("desk_pet_open", { target: { kind: "settings" } }) },
        { item: "Separator" },
        { id: "hide", text: "隐藏桌宠", action: () => void invoke("desk_pet_hide") },
      ],
    });
    await menu.popup();
  }

  const mood = buddyMood(buddyDayPart(hour));
  const waiting = waitingCount(feed.items);
  const { pose, prop } = petPose({
    drag,
    reaction,
    waiting,
    working: feed.working,
    rest: { pose: mood.restPose, prop: mood.prop },
  });
  const dnd = Date.now() < dndUntil;
  const title = dnd
    ? "勿扰中（右键结束）"
    : waiting
      ? `${waiting} 件事要你看一眼，点开看`
      : feed.working
        ? "有活在做"
        : "没有等你的事";

  const petEl = (
    <div
      className="pet-body"
      style={{ width: compact, height: compact }}
      onMouseDown={onPetDown}
      onMouseMove={onPetMove}
      onMouseUp={onPetUp}
      onContextMenu={onContextMenu}
      title={title}
    >
      <MesaBuddy size={pet} pose={pose} prop={prop} />
      {waiting > 0 && !dnd && <span className="pet-badge">{waiting > 9 ? "9+" : waiting}</span>}
    </div>
  );

  return (
    <div className={`pet-root ${light ? "pet-light" : "pet-dark"} ${layout.side === "left" ? "pet-side-left" : "pet-side-right"} ${layout.below ? "pet-below" : ""}`}>
      {panel && (
        <div className="pet-panel" onMouseEnter={() => (hovering.current = true)} onMouseLeave={() => (hovering.current = false)}>
          {panel.kind === "bubble" ? (
            <Bubble
              text={bubbleText(panel.item, panel.count)}
              onOpen={() => setPanel({ kind: "list" })}
              onClose={() => setPanel(null)}
            />
          ) : (
            <ItemList items={feed.items} working={feed.working} onClose={() => setPanel(null)} />
          )}
        </div>
      )}
      {petEl}
    </div>
  );
}

function Bubble({ text, onOpen, onClose }: { text: string; onOpen: () => void; onClose: () => void }) {
  return (
    <div className="pet-bubble" role="status">
      <button type="button" className="pet-bubble-text" onClick={onOpen} title="点开看">
        {text}
      </button>
      <button type="button" className="pet-x" onClick={onClose} aria-label="知道了">
        ✕
      </button>
    </div>
  );
}

function openTarget(target: PetOpen | null) {
  void invoke("desk_pet_open", { target });
}

function ItemList({ items, working, onClose }: { items: PetItem[]; working: boolean; onClose: () => void }) {
  return (
    <div className="pet-card">
      <div className="pet-card-head">
        <span className="pet-card-title">{items.length ? `要你看一眼 · ${items.length}` : working ? "有活在做，没有等你的事" : "没有等你的事"}</span>
        <button type="button" className="pet-x" onClick={onClose} aria-label="收起">
          ✕
        </button>
      </div>
      <ol className="pet-items">
        {items.map((item) => (
          <PetRow key={item.key} item={item} />
        ))}
      </ol>
      <div className="pet-card-foot">
        <button type="button" className="pet-link" onClick={() => openTarget(null)}>
          打开 Mesa
        </button>
      </div>
    </div>
  );
}

function PetRow({ item }: { item: PetItem }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [draft, setDraft] = useState("");

  async function act(payload: { tap: "reply" | "grant" | "trust"; value?: string; optionLabel?: string; accept?: boolean }) {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBusy(true);
    setResult(null);
    const off = await listen<{ reqId: string; ok: boolean; message: string }>("desk-pet:act-done", (e) => {
      if (e.payload.reqId !== reqId) return;
      setBusy(false);
      setResult({ ok: e.payload.ok, message: e.payload.message });
      if (e.payload.ok) setDraft("");
      off();
    });
    await emitTo("main", "desk-pet:act", { reqId, projectPath: item.projectPath, key: item.key, ...payload });
  }

  const done = result?.ok;
  return (
    <li className="pet-item">
      <p className="pet-item-meta">
        {item.projectName} · {petKindLabel(item.kind)}
      </p>
      <p className="pet-item-text">{item.kind === "help" || item.kind === "question" ? `${item.where}：${item.text}` : item.text}</p>
      {item.detail && <p className="pet-item-detail">{item.detail}</p>}
      {!done && (
        <div className="pet-actions">
          {item.tap === "reply" &&
            item.options.map((o) => (
              <button key={o.key} type="button" className="pet-btn" disabled={busy} onClick={() => void act({ tap: "reply", value: o.key, optionLabel: o.label })}>
                {o.key}：{o.label}
                {item.recommend === o.key ? "（建议）" : ""}
              </button>
            ))}
          {item.tap === "grant" && (
            <>
              <button type="button" className="pet-btn" disabled={busy} title="只下一次联网不限，跑完回到原来的授权" onClick={() => void act({ tap: "grant", accept: true })}>
                放宽重跑这一次
              </button>
              <button type="button" className="pet-btn pet-btn-ghost" disabled={busy} onClick={() => void act({ tap: "grant", accept: false })}>
                不用
              </button>
            </>
          )}
          {item.tap === "trust" && (
            <>
              <button type="button" className="pet-btn" disabled={busy} onClick={() => void act({ tap: "trust", accept: true })}>
                信任并继续
              </button>
              <button type="button" className="pet-btn pet-btn-ghost" disabled={busy} onClick={() => void act({ tap: "trust", accept: false })}>
                不信任
              </button>
            </>
          )}
          <button type="button" className="pet-btn pet-btn-ghost" onClick={() => openTarget(item.open)}>
            去看看
          </button>
        </div>
      )}
      {item.tap === "reply" && !done && (
        <form
          className="pet-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void act({ tap: "reply", value: draft.trim() });
          }}
        >
          <input className="pet-input" value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder="写一句送过去" />
        </form>
      )}
      {busy && <p className="pet-item-detail">送出去…</p>}
      {result && <p className={result.ok ? "pet-ok" : "pet-err"}>{result.message}</p>}
    </li>
  );
}
