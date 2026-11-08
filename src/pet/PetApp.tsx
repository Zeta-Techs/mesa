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
  petLean,
  readPetDnd,
  defaultAskProject,
  PET_DND_KEY,
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
const SEEN_KEY = "ccode.deskPet.seen";

interface PetSettings {
  theme?: string;
  deskPetSay?: PetSay;
  deskPetSize?: Size;
}

type Panel = { kind: "bubble"; item: PetItem; count: number } | { kind: "list" } | null;

const ASK_PROJECT_KEY = "ccode.deskPet.askProject";

interface AskState {
  reqId: string;
  projectPath: string;
  projectName: string;
  question: string;
  progress: string | null;
  done: { ok: boolean; text: string; clarify: { question: string; options: string[] } | null; deskOnly: string[] } | null;
}


export default function PetApp() {
  const win = useMemo(() => getCurrentWindow(), []);
  const [settings, setSettings] = useState<PetSettings>({});
  const [feed, setFeed] = useState<PetFeed>({ working: false, items: [] });
  const [panel, setPanel] = useState<Panel>(null);
  const [reaction, setReaction] = useState<"oops" | "happy" | null>(null);
  const [drag, setDrag] = useState<"left" | "right" | null>(null);
  const [dndUntil, setDndUntil] = useState(readPetDnd);
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
            localStorage.setItem(PET_DND_KEY, String(until));
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

  // 朝鼠标倾身：只在面板收着、站着 / 等你 / 在想时，约每 150ms 看一次鼠标；减弱动态效果时不动
  const [lean, setLean] = useState({ rotate: 0, x: 0, y: 0 });
  const leanable = !panel && !drag && !reaction;
  useEffect(() => {
    if (!leanable || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setLean({ rotate: 0, x: 0, y: 0 });
      return;
    }
    let stop = false;
    const tick = async () => {
      const at = await invoke<[number, number] | null>("desk_pet_cursor").catch(() => null);
      const h = home.current;
      if (stop) return;
      setLean(at && h ? petLean(at[0] - (h.x + compact / 2), at[1] - (h.y + compact / 2)) : { rotate: 0, x: 0, y: 0 });
    };
    const timer = window.setInterval(() => void tick(), 150);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [leanable, compact]);

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
      <div
        className="pet-lean"
        style={{
          // 睡着不转身
          transform: pose === "sleep" ? undefined : `translate(${lean.x}px, ${lean.y}px) rotate(${lean.rotate}deg)`,
        }}
      >
        <MesaBuddy size={pet} pose={pose} prop={prop} />
      </div>
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
            <ItemList feed={feed} working={feed.working} onClose={() => setPanel(null)} />
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

function ItemList({ feed, working, onClose }: { feed: PetFeed; working: boolean; onClose: () => void }) {
  const items = feed.items;
  const [ask, setAsk] = useState<AskState | null>(null);
  return (
    <div className="pet-card">
      <div className="pet-card-head">
        <span className="pet-card-title">
          {ask ? "问项目助手" : items.length ? `要你看一眼 · ${items.length}` : working ? "有活在做，没有等你的事" : "没有等你的事"}
        </span>
        {ask && (
          <button type="button" className="pet-link" onClick={() => setAsk(null)}>
            返回
          </button>
        )}
        <button type="button" className="pet-x" onClick={onClose} aria-label="收起">
          ✕
        </button>
      </div>
      {ask ? (
        <AskView ask={ask} />
      ) : (
        <ol className="pet-items">
          {items.map((item) => (
            <PetRow key={item.key} item={item} />
          ))}
        </ol>
      )}
      <AskBox feed={feed} ask={ask} setAsk={setAsk} />
    </div>
  );
}

/** 问小桌（第二期）：选项目 + 一句话，交给那个项目的项目助手；问答照常记进那个项目，在 Mesa 里也看得到 */
function AskBox({ feed, ask, setAsk }: { feed: PetFeed; ask: AskState | null; setAsk: (fn: (a: AskState | null) => AskState | null) => void }) {
  const projects = feed.projects ?? [];
  const [project, setProject] = useState<string | null>(() => defaultAskProject(feed, localStorage.getItem(ASK_PROJECT_KEY)));
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (!project || !projects.some((p) => p.path === project)) setProject(defaultAskProject(feed, localStorage.getItem(ASK_PROJECT_KEY)));
  }, [feed, project, projects]);
  const busy = !!ask && !ask.done;

  async function send(question: string) {
    const q = question.trim();
    if (!q || !project || busy) return;
    const name = projects.find((p) => p.path === project)?.name ?? "";
    localStorage.setItem(ASK_PROJECT_KEY, project);
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setAsk(() => ({ reqId, projectPath: project, projectName: name, question: q, progress: null, done: null }));
    setDraft("");
    const offProgress = await listen<{ reqId: string; text: string }>("desk-pet:ask-progress", (e) => {
      if (e.payload.reqId === reqId) setAsk((a) => (a && a.reqId === reqId ? { ...a, progress: e.payload.text } : a));
    });
    const offDone = await listen<{ reqId: string } & NonNullable<AskState["done"]>>("desk-pet:ask-done", (e) => {
      if (e.payload.reqId !== reqId) return;
      const { ok, text, clarify, deskOnly } = e.payload;
      setAsk((a) => (a && a.reqId === reqId ? { ...a, done: { ok, text, clarify, deskOnly } } : a));
      offProgress();
      offDone();
    });
    await emitTo("main", "desk-pet:ask", { reqId, projectPath: project, question: q });
  }

  // 它追问时的选项：点了当下一句问回去
  useEffect(() => {
    const onPick = (e: Event) => void send((e as CustomEvent<string>).detail);
    window.addEventListener("pet-ask-pick", onPick);
    return () => window.removeEventListener("pet-ask-pick", onPick);
  });

  if (!projects.length) {
    return (
      <div className="pet-card-foot">
        <button type="button" className="pet-link" onClick={() => openTarget(null)}>
          打开 Mesa
        </button>
      </div>
    );
  }
  return (
    <form
      className="pet-ask"
      onSubmit={(e) => {
        e.preventDefault();
        void send(draft);
      }}
    >
      <select className="pet-select" value={project ?? ""} onChange={(e) => setProject(e.target.value)} title="问哪个项目的项目助手" disabled={busy}>
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name}
          </option>
        ))}
      </select>
      <input className="pet-input" value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} placeholder={busy ? "正在想…" : "问项目助手"} />
    </form>
  );
}

function AskView({ ask }: { ask: AskState }) {
  const d = ask.done;
  return (
    <div className="pet-items pet-ask-view">
      <p className="pet-item-meta">{ask.projectName} · 你问</p>
      <p className="pet-item-text">{ask.question}</p>
      <p className="pet-item-meta pet-ask-gap">项目助手</p>
      {!d && <p className="pet-item-detail">{ask.progress ?? "正在想…"}</p>}
      {d && <p className={d.ok ? "pet-answer" : "pet-err"}>{d.ok ? d.text : `没问成：${d.text}`}</p>}
      {d?.clarify && (
        <>
          <p className="pet-item-text pet-ask-gap">{d.clarify.question}</p>
          {d.clarify.options.length > 0 && (
            <div className="pet-actions">
              {d.clarify.options.map((o) => (
                <button key={o} type="button" className="pet-btn" onClick={() => window.dispatchEvent(new CustomEvent("pet-ask-pick", { detail: o }))}>
                  {o}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {d && d.deskOnly.length > 0 && (
        <div className="pet-ask-gap">
          <p className="pet-item-detail">它还{d.deskOnly.join("、")}，要在 Mesa 里点。</p>
          <div className="pet-actions">
            <button type="button" className="pet-btn" onClick={() => openTarget({ kind: "assistant", projectPath: ask.projectPath })}>
              在 Mesa 里看这条回答
            </button>
          </div>
        </div>
      )}
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
