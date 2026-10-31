import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, FoldMark, MenuSelect, fieldClass } from "./PageFrame";
import type { ModelCapabilityDto, ModelCapsOverrideDto, RoleModels } from "../types";
import { claudeCustomOption, explicitClaudeRoles } from "../role-models";
import { contextLabel } from "../model-caps-label";
import { oneMOverrideEntry, oneMState } from "../model-caps-override";

/**
 * 连接弹层里 Claude Code 的「模型映射」表（2026-10-30 用户拍板，docs/design-connection-agent-forms.md）：
 * 默认 / Sonnet / Opus / Haiku / Fable / 子 Agent 各指向名单里的哪个模型，/model 里的显示名，上下文（1M 就地声明）。
 * 取代「名单顺序占槽」与只读的「Claude 别名指向」。数据：默认 = 名单第一个（改它就是挪顺序），
 * Sonnet / Opus / Fable = roleModels.slots，Haiku = roleModels.small，子 Agent = roleModels.subagent，
 * 显示名 = roleModels.displayNames。1M 写的是全局「能力声明」（按模型，所有 Agent 共用）。
 */
export function ClaudeModelMapping({
  models,
  roles,
  connName,
  gatewayId,
  onRolesChange,
  onSetDefault,
}: {
  /** 名单（已去空去重，第一个是默认） */
  models: string[];
  roles: RoleModels;
  connName: string;
  gatewayId: string | null;
  onRolesChange: (roles: RoleModels) => void;
  /** 把这个模型挪到名单第一个 */
  onSetDefault: (model: string) => void;
}) {
  const main = models[0];
  const [caps, setCaps] = useState<Record<string, ModelCapabilityDto>>({});
  const [overrides, setOverrides] = useState<Record<string, ModelCapsOverrideDto>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 显示名很少改：收在表下一行，点开再逐个填（2026-10-31：四列在窄弹层里全被截断）
  const [namesOpen, setNamesOpen] = useState(false);
  const modelsKey = models.join("\n");

  async function loadCaps() {
    try {
      const [list, ov] = await Promise.all([
        invoke<ModelCapabilityDto[]>("model_capabilities", { models, gatewayId }),
        invoke<ModelCapsOverrideDto[]>("list_model_capability_overrides"),
      ]);
      setCaps(Object.fromEntries(list.map((c) => [c.model, c])));
      setOverrides(Object.fromEntries(ov.map((e) => [e.prefix, e])));
    } catch (e) {
      setError(`读不到模型能力：${String(e)}`);
    }
  }
  useEffect(() => {
    void loadCaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsKey, gatewayId]);

  if (!main) return null;
  // 开始改表就转成显式映射（旧绑定按名单顺序算出初值，用户看到的指向不变）
  const explicit = explicitClaudeRoles(models, roles);
  const set = (patch: Partial<RoleModels>) => onRolesChange({ ...explicit, ...patch });
  const slotValue = (k: string) => explicit.slots?.[k] ?? "";
  // 「跟默认」不再带模型名：第一行就写着默认是谁，带上了在窄下拉里只剩「跟默认（gpt-5…」
  const options = [{ value: "", label: "跟默认" }, ...models.map((m) => ({ value: m, label: m }))];

  async function toggle1M(model: string, on: boolean) {
    setPending(model);
    setError(null);
    try {
      const entry = oneMOverrideEntry(model, on, overrides[model.toLowerCase()] ?? overrides[model]);
      if (entry) await invoke("set_model_capability_override", { entry });
      else await invoke("clear_model_capability_override", { prefix: model });
      await loadCaps();
    } catch (e) {
      setError(`能力声明保存失败：${String(e)}`);
    } finally {
      setPending(null);
    }
  }

  const rows: {
    key: string;
    label: string;
    hint?: string;
    value: string;
    onChange: (v: string) => void;
    showsInPicker: boolean;
    withFollow: boolean;
  }[] = [
    { key: "default", label: "默认", hint: "启动时用它", value: main, onChange: (v) => v && onSetDefault(v), showsInPicker: true, withFollow: false },
    { key: "sonnet", label: "Sonnet", value: slotValue("sonnet"), onChange: (v) => set({ slots: { ...explicit.slots, sonnet: v } }), showsInPicker: true, withFollow: true },
    { key: "opus", label: "Opus", value: slotValue("opus"), onChange: (v) => set({ slots: { ...explicit.slots, opus: v } }), showsInPicker: true, withFollow: true },
    { key: "haiku", label: "Haiku", hint: "会话标题、网页摘要这类后台小任务也用它", value: explicit.small ?? "", onChange: (v) => set({ small: v || null }), showsInPicker: true, withFollow: true },
    { key: "fable", label: "Fable", value: slotValue("fable"), onChange: (v) => set({ slots: { ...explicit.slots, fable: v } }), showsInPicker: true, withFollow: true },
    { key: "subagent", label: "子 Agent", hint: "主对话派出去的子任务（Agent / Task 工具）", value: explicit.subagent ?? "", onChange: (v) => set({ subagent: v || null }), showsInPicker: false, withFollow: true },
  ];
  const extra = claudeCustomOption(models, explicit, main);
  const names = explicit.displayNames ?? {};

  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-l3">Claude Code 怎么用这些模型</span>
        <button
          type="button"
          className="text-l3 hover:text-l1"
          onClick={() => set({ slots: {}, small: null, subagent: null })}
        >
          {/* 字号写在内层：全站 button { font: inherit } 会吞掉按钮上的 text-* */}
          <span className="text-xs">全部跟默认</span>
        </button>
      </div>
      <div className="rounded-md border border-hairline px-3 py-2.5">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-xs">
          <span className="text-micro text-l3">角色</span>
          <span className="text-micro text-l3">实际请求模型</span>
          <span className="text-micro text-l3" title="勾上 = 声明这个模型支持 1M 上下文">上下文 · 声明 1M</span>
          {rows.map((r) => {
            const effective = r.value || main;
            const cap = caps[effective];
            const ov = overrides[effective.toLowerCase()] ?? overrides[effective];
            const oneM = oneMState(cap?.context, ov);
            return (
              <div key={r.key} className="contents">
                <span className="text-l2" title={r.hint}>
                  {r.label}
                </span>
                <span className="min-w-0 text-sm">
                  <MenuSelect
                    aria-label={`${r.label} 实际请求模型`}
                    value={r.value}
                    options={r.withFollow ? options : options.slice(1)}
                    onChange={r.onChange}
                  />
                </span>
                {/* 先写长度、再放「1M」勾选（原先「1M 128K」读起来像两个数） */}
                <span className="flex items-center justify-end gap-2">
                  <span className="w-10 text-right text-micro text-l3">
                    {contextLabel(cap?.context) ?? (oneM.checked ? "1M" : "未知")}
                  </span>
                  <Checkbox
                    checked={oneM.checked}
                    disabled={oneM.locked || pending === effective}
                    onChange={(on) => void toggle1M(effective, on)}
                    label={<span className="sr-only">{`声明 ${effective} 支持 1M 上下文`}</span>}
                    title={
                      oneM.locked
                        ? `能力库确知 ${effective} 有 1M 上下文`
                        : `声明 ${effective} 支持 1M 上下文：对所有 Agent 生效（网关库「能力声明」同一处）`
                    }
                  />
                </span>
              </div>
            );
          })}
        </div>
        {/* /model 菜单里的显示名：只列会出现在菜单里的模型（子 Agent 不进菜单） */}
        <div className="mt-2 border-t border-hairline pt-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-l3 hover:text-l1"
            onClick={() => setNamesOpen((v) => !v)}
          >
            <FoldMark open={namesOpen} />
            <span className="text-xs">改 /model 里的显示名</span>
            {!namesOpen && Object.keys(names).length > 0 && (
              <span className="text-micro text-l3">已改 {Object.keys(names).length} 个</span>
            )}
          </button>
          {namesOpen && (
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
              {[...new Set(rows.filter((r) => r.showsInPicker).map((r) => r.value || main).concat(extra ? [extra] : []))].map((m) => (
                <div key={m} className="contents">
                  <span className="truncate font-mono text-l2" title={m}>
                    {m}
                  </span>
                  <input
                    className={`${fieldClass} h-8 text-xs`}
                    aria-label={`${m} 在 /model 里的显示名`}
                    placeholder={`${connName || "连接名"} · ${m}`}
                    value={names[m] ?? ""}
                    onChange={(e) => {
                      const next = { ...names };
                      if (e.target.value.trim()) next[m] = e.target.value;
                      else delete next[m];
                      set({ displayNames: next });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <ExtraOptionNote model={extra} />
        {error && <p className="mt-2 text-micro text-err-text">{error}</p>}
        <p className="mt-2 text-micro leading-4 text-l3">
          「跟默认」= 启动时选的模型（没选就是「默认」一行）。只作用于 Mesa 启动的会话和「设为全局默认」；你本机 Claude
          设置里的同名配置在 Mesa 启动时会被盖过。勾 1M 是声明这个模型本身的能力，所有 Agent 共用。
        </p>
      </div>
    </div>
  );
}

function ExtraOptionNote({ model: extra }: { model: string | null }) {
  if (!extra) return null;
  return (
    <p className="mt-2 text-micro leading-4 text-l3">
      名单里没对上别名的 <span className="font-mono text-l2">{extra}</span> 会作为 /model 菜单里另加的一项。
    </p>
  );
}
