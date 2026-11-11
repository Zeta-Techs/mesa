import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X } from "lucide-react";
import { Modal } from "./Modal";
import AgentModelPicker from "./AgentModelPicker";
import { compactFieldClass, fieldClass, primaryActionClass, quietActionClass } from "./PageFrame";
import { MemberAvatar } from "./ConsultView";
import type { SearchResultDto } from "./FileTree";
import { useAppStore, selectHiddenProfiles } from "../store";
import { samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { saveClipboardImage } from "../clipboard-image";
import { imageExtFromMime } from "../terminal-input";
import { DISCUSS_BINDING_SLOT, slotPrefs } from "../project-agents";
import {
  DEFAULT_CROSS_ROUNDS,
  estimateCost,
  MAX_IMAGES,
  familyName,
  INSPECT_AGENTS,
  MAX_MATERIALS,
  MAX_MEMBERS,
  MIN_MEMBERS,
  memberNames,
  memberOptions,
  pickDefaultMembers,
  sameFamilies,
  toProjectRel,
  usdText,
  type ConsultDto,
  type ConsultMaterial,
  type CostStat,
  type MemberOption,
} from "../consult";
import { AGENTS, type ProjectDto } from "../types";

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;
const LAST_KEY = (root: string) => `consultLast:${root}`;

/**
 * 发起研讨（2026-11-11，docs/design-group-consult.md §4.1）：问题、材料、请谁、交叉几轮，一屏填完。
 * 请谁默认：「问 AI / 聊想法」那条连接打头，之后每位模型族不同、同族里优先外壳能看项目的；记住上次选的。
 */
export default function ConsultStartDialog({
  open,
  onClose,
  projects,
  initial,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projects: { path: string; name: string }[];
  initial: {
    projectRoot?: string | null;
    question?: string;
    materials?: ConsultMaterial[];
    /** 评审页发起：成员读这一步的工作副本（产物还没带回项目根），记录照样写在项目里 */
    readRoot?: string;
    readLabel?: string;
    /** 步骤卡发起：是哪一步（换了项目就不带） */
    step?: string;
  } | null;
  /** members：几家在答（开始后的提示里写） */
  onCreated: (projectRoot: string, id: string, members: number) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const hidden = useAppStore(selectHiddenProfiles);
  const options = useMemo(() => memberOptions(profiles, hidden), [profiles, hidden]);
  const [root, setRoot] = useState("");
  const [question, setQuestion] = useState("");
  const [materials, setMaterials] = useState<ConsultMaterial[]>([]);
  const [picked, setPicked] = useState<MemberOption[]>([]);
  const [cross, setCross] = useState(DEFAULT_CROSS_ROUNDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [hits, setHits] = useState<SearchResultDto[]>([]);
  /** 粘贴 / 拖进来的图（二期）：先落 Mesa 的粘贴目录，开始研讨时后端拷进项目 attachments */
  const [images, setImages] = useState<{ path: string; url: string }[]>([]);
  const [imageNote, setImageNote] = useState<string | null>(null);
  async function addImageFile(file: File) {
    if (images.length >= MAX_IMAGES) {
      setImageNote(`一次最多附 ${MAX_IMAGES} 张图`);
      return;
    }
    try {
      const path = await saveClipboardImage(await file.arrayBuffer(), imageExtFromMime(file.type));
      setImages((cur) => (cur.length >= MAX_IMAGES ? cur : [...cur, { path, url: URL.createObjectURL(file) }]));
      setImageNote(null);
    } catch (reason) {
      setImageNote(`图没贴上：${String(reason)}`);
    }
  }
  const qRef = useRef<HTMLTextAreaElement>(null);
  const readRoot = initial?.readRoot || null;
  const fileRoot = readRoot ?? root;
  /** 以往研讨每位每次的平均花费（各已添加项目合起来）：打开弹层时读一次 */
  const [costStats, setCostStats] = useState<CostStat[]>([]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void invoke<CostStat[]>("consult_cost_stats", { projectRoots: projects.map((p) => p.path) })
      .then((s) => {
        if (!stale) setCostStats(s);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // 只在打开时读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 打开时按入口预填；成员按上次选的，没有就按默认挑法
  useEffect(() => {
    if (!open) return;
    // 入口给的目录不是已添加的项目（随手聊一类）时退回第一个项目；工作副本发起的照入口给的
    const asked = initial?.projectRoot ?? null;
    const known = asked && (initial?.readRoot || projects.some((p) => samePath(p.path, asked, IS_WINDOWS)));
    const r = (known ? asked : null) ?? projects[0]?.path ?? "";
    setRoot(r);
    setQuestion(initial?.question ?? "");
    setMaterials(initial?.materials?.slice(0, MAX_MATERIALS) ?? []);
    setCross(DEFAULT_CROSS_ROUNDS);
    setError(null);
    setFileQuery("");
    setImages([]);
    setImageNote(null);
    // projects 每次渲染是新数组，只在打开 / 换入口时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  useEffect(() => {
    if (!open || !root) return;
    let stale = false;
    const last = (() => {
      try {
        return JSON.parse(localStorage.getItem(LAST_KEY(root)) ?? "[]") as string[];
      } catch {
        return [];
      }
    })();
    const fromLast = last.map((k) => options.find((o) => o.key === k)).filter((o): o is MemberOption => !!o);
    if (fromLast.length >= MIN_MEMBERS) {
      setPicked(fromLast.slice(0, MAX_MEMBERS));
      return;
    }
    void invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        if (stale) return;
        const project = list.find((p) => p.path === root);
        const prefs = slotPrefs(profiles, project, DISCUSS_BINDING_SLOT);
        const first =
          options.find((o) => o.profileId === prefs.preferredProfile && (!prefs.preferredModel || o.model === prefs.preferredModel)) ?? null;
        setPicked(pickDefaultMembers(options, first?.key ?? null));
      })
      .catch(() => !stale && setPicked(pickDefaultMembers(options, null)));
    return () => {
      stale = true;
    };
  }, [open, root, options, profiles]);

  // 材料：在项目里搜文件
  useEffect(() => {
    if (!open || !fileRoot || !fileQuery.trim()) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void invoke<SearchResultDto[]>("search_files", { root: fileRoot, query: fileQuery.trim(), showHidden: false })
        .then((r) => setHits(r.filter((x) => !x.isDir).slice(0, 8)))
        .catch(() => setHits([]));
    }, 150);
    return () => window.clearTimeout(t);
  }, [open, fileRoot, fileQuery]);

  const names = memberNames(picked);
  const dupFamilies = sameFamilies(picked);
  const est = estimateCost(picked, cross, costStats);
  const estMoney =
    est.usd != null ? `，按以往研讨约 ${usdText(est.usd)}${est.guessed ? `（${est.guessed} 位没有记录，按平均估）` : ""}` : "";
  const canStart = !!root && question.trim().length > 0 && picked.length >= MIN_MEMBERS && !busy;
  const allSame = picked.length >= 2 && new Set(picked.map((p) => p.family ?? p.key)).size === 1;

  function addMaterial(path: string) {
    const rel = toProjectRel(path, fileRoot);
    if (!rel) {
      setError("材料只能是这个项目里的文件");
      return;
    }
    setMaterials((ms) => (ms.some((m) => m.path === rel) || ms.length >= MAX_MATERIALS ? ms : [...ms, { path: rel, range: "" }]));
    setFileQuery("");
    setHits([]);
  }

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const dto = await invoke<ConsultDto>("consult_create", {
        projectRoot: root,
        question: question.trim(),
        materials,
        members: picked.map((o, i) => ({
          name: names[i],
          family: o.family,
          agent: o.agentId,
          profileId: o.profileId,
          model: o.model,
        })),
        crossRounds: cross,
        relayLimit: null,
        readRoot,
        readLabel: initial?.readLabel ?? null,
        images: images.map((i) => i.path),
        step: initial?.step && initial.projectRoot === root ? initial.step : null,
      });
      localStorage.setItem(LAST_KEY(root), JSON.stringify(picked.map((p) => p.key)));
      onCreated(root, dto.consult.meta.id, dto.consult.meta.members.length);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const optionLabel = (o: MemberOption) =>
    `${familyName(o.family) ?? o.profileName} · ${o.model || "默认模型"} · ${o.profileName}（${agentLabel(o.agentId)}${o.canRead ? "" : "，只看材料"}）`;

  return (
    <Modal
      // 评审覆盖层（z-50）上也能打开：压在最上层
      layer="overlay"
      open={open}
      onClose={onClose}
      size="lg"
      title="研讨"
      initialFocusRef={qRef}
      description="同一个问题请几家一起看：先各答各的，再看别家的答案补充或反驳。它们只看不改，不跑命令。"
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-micro text-l4">
            {picked.length >= MIN_MEMBERS
              ? `大约 ${est.calls} 次调用（${picked.length} 位 × ${1 + cross} 轮）${estMoney}，追问另算`
              : `至少请 ${MIN_MEMBERS} 位`}
          </span>
          <button type="button" onClick={onClose} className={quietActionClass}>
            取消
          </button>
          <button type="button" disabled={!canStart} onClick={() => void start()} className={primaryActionClass}>
            {busy ? "正在开始…" : "开始研讨"}
          </button>
        </div>
      }
    >
      <div
        className="space-y-4"
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          for (const f of files) void addImageFile(f);
        }}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.items).some((it) => it.type.startsWith("image/"))) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          for (const f of files) void addImageFile(f);
        }}
      >
        {readRoot && (
          <div className="rounded-lg bg-inset px-3 py-2 text-xs text-l2">
            看的是 <span className="text-l1">{initial?.readLabel ?? "工作副本"}</span>：这一步交的东西还没带回项目，成员读这一份；记录照样存在项目里。
          </div>
        )}
        {projects.length > 1 && !readRoot && (
          <Field label="项目">
            <select value={root} onChange={(e) => setRoot(e.target.value)} className={`${compactFieldClass} w-full`}>
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="问题">
          <textarea
            ref={qRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="比如：亚组按测序平台分站得住吗？还是该改回按地区？"
            className={`${fieldClass} resize-y leading-relaxed`}
          />
        </Field>

        <Field label="材料" hint="项目里的文件，可以只写几行（12-40）或某一节（§2.4）；截图直接粘贴或拖进来">
          <div className="space-y-1.5">
            {materials.map((m, i) => (
              <div key={m.path} className="flex items-center gap-2 rounded-lg border border-hairline bg-canvas px-2 py-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-l1" title={m.path}>
                  {m.path}
                </code>
                <input
                  value={m.range}
                  onChange={(e) => setMaterials((ms) => ms.map((x, j) => (j === i ? { ...x, range: e.target.value } : x)))}
                  placeholder="全文"
                  className="h-6 w-24 rounded-md border border-transparent bg-transparent px-1.5 text-xs text-l3 outline-none placeholder:text-l4 hover:border-field focus:border-field"
                />
                <button
                  type="button"
                  aria-label={`去掉 ${m.path}`}
                  onClick={() => setMaterials((ms) => ms.filter((_, j) => j !== i))}
                  className="rounded-md p-0.5 text-l4 hover:bg-hover hover:text-l1"
                >
                  <X size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            ))}
            {images.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5" aria-label="附的图">
                {images.map((img, i) => (
                  <span key={img.path} className="group relative">
                    <img src={img.url} alt={`图 ${i + 1}`} className="size-12 rounded-md border border-hairline object-cover" />
                    <button
                      type="button"
                      aria-label={`去掉图 ${i + 1}`}
                      onClick={() => setImages((cur) => cur.filter((x) => x.path !== img.path))}
                      className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-raised text-l3 ring-1 ring-hairline hover:text-l1"
                    >
                      <X size={10} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                <span className="text-micro text-l4">只给能看项目、模型又能看图的成员看；其余成员会被告知有图但看不到</span>
              </div>
            )}
            {imageNote && <div className="text-micro text-warn-text">{imageNote}</div>}
            {materials.length < MAX_MATERIALS && (
              <div className="relative">
                <input
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hits[0]) {
                      e.preventDefault();
                      addMaterial(hits[0].path);
                    }
                  }}
                  placeholder="＋ 搜项目里的文件加进来"
                  className={`${compactFieldClass} w-full`}
                />
                {hits.length > 0 && (
                  <div className="absolute inset-x-0 top-8 z-10 overflow-hidden rounded-lg border border-hairline bg-raised py-1 shadow-lg">
                    {hits.map((h) => (
                      <button
                        key={h.path}
                        type="button"
                        onClick={() => addMaterial(h.path)}
                        className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                      >
                        <span className="truncate font-mono text-xs">{h.rel}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Field>

        <Field label="请谁" hint="二到四位，模型最好是不同的几家；「只看材料」的看不到项目，只看上面这几份的摘录">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {picked.map((o, i) => (
              <div key={o.key} className="group relative rounded-lg border border-cta-bd bg-canvas p-2 ring-1 ring-inset ring-cta-bd/40">
                <div className="flex items-center gap-1.5">
                  <MemberAvatar member={{ family: o.family, name: names[i] }} size={20} />
                  <span className="min-w-0 truncate text-xs font-medium text-l1">{names[i]}</span>
                </div>
                <div className="mt-1 truncate text-micro text-l3" title={optionLabel(o)}>
                  {o.model || "默认模型"} · {agentLabel(o.agentId)}
                </div>
                <div className={`mt-1 text-micro ${o.canRead ? "text-l4" : "text-warn-text"}`}>{o.canRead ? "能看项目" : "只看材料"}</div>
                {o.family && dupFamilies.has(o.family) && <div className="mt-0.5 text-micro text-warn-text">同一家模型，意见可能雷同</div>}
                <button
                  type="button"
                  aria-label={`不请 ${names[i]}`}
                  onClick={() => setPicked((ps) => ps.filter((p) => p.key !== o.key))}
                  className="absolute right-1 top-1 rounded-md p-0.5 text-l4 opacity-0 hover:bg-hover hover:text-l1 group-hover:opacity-100"
                >
                  <X size={12} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            ))}
            {picked.length < MAX_MEMBERS && (
              // 两层小菜单（先一家、再连接 · 模型），同聊天层换 Agent；原生下拉一次摊开几十行太长（2026-11-11 用户）
              <AgentModelPicker
                options={options
                  .filter((o) => !picked.some((p) => p.key === o.key))
                  .map((o) => {
                    const dup = o.family ? picked.find((p) => p.family === o.family) : undefined;
                    return dup ? { ...o, warn: `与 ${names[picked.indexOf(dup)]} 同一家模型` } : o;
                  })}
                onPick={(o) => setPicked((ps) => [...ps, o])}
                title="再请一位"
                hint="模型最好和已请的不是同一家。"
                agentNote={(id) =>
                  INSPECT_AGENTS.includes(id)
                    ? null
                    : { short: "只看材料", long: "只看材料：这家看不到项目，只看上面这几份的摘录", warn: true }
                }
                ariaLabel="再请一位"
                triggerClassName="flex min-h-[4.5rem] items-center justify-center gap-1 rounded-lg border border-dashed border-field text-xs text-l3 hover:bg-hover hover:text-l1"
              >
                <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
                <span className="text-xs">再请一位</span>
              </AgentModelPicker>
            )}
          </div>
          {options.length === 0 && <div className="mt-1.5 text-micro text-warn-text">还没有能用的连接，先到连接页加一条。</div>}
          {allSame && <div className="mt-1.5 text-micro text-warn-text">请的都是同一家模型，研讨意义不大；换一位不同家的会更有用。</div>}
        </Field>

        <div className="flex items-center gap-3">
          <span className="text-xs text-l1">看完别家后再答</span>
          <div className="inline-flex rounded-lg border border-hairline bg-canvas p-0.5">
            {[0, 1, 2].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCross(n)}
                className={`h-6 rounded-md px-3 text-xs ${cross === n ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"}`}
              >
                <span className="text-xs">{n === 0 ? "不用" : `${n} 轮`}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="text-xs text-err-text">{error}</div>}
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-medium text-l1">{label}</span>
        {hint && <span className="min-w-0 truncate text-micro text-l4">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
