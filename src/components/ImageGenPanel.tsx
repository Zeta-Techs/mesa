// 出图模型面板（2026-10-23 设置页首版；2026-10-24 用户「连接这里配置生图模型」→ 编辑入口挪到连接页）。
// 从各网关目录里挑一个出图模型给 Agent 用（后端 image_gen.rs）：选、试出一张、给已装 Agent 打开技能 image-gen。
// 存在设置的 imageGenGatewayId + imageGenModel（同进退）；连接页是唯一编辑处，设置页只显示现状并跳过来。
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { fieldClass, settingsPillClass } from "./PageFrame";
import { useAppStore } from "../store";
import { toast } from "../toast";
import { AGENTS, type DetectResult, type SkillDto } from "../types";

type ImageGenGateway = { gatewayId: string; gatewayName: string; models: string[] };
type ImageGenTest = { dataUrl: string; protocol: string; elapsedMs: number; note?: string | null };
const SEP = "\u0001";
// 选择器缺省值用模块级常量（zustand v5 每次新数组会无限重渲染；store-selector-lint 测试钉住）
const NO_AGENTS: DetectResult[] = [];

const selectClass = fieldClass.replace("w-full ", "").replace("py-1.5", "h-9") + " w-80 max-w-full";

/** 把某网关的某个出图模型设为出图模型（连接行「改作出图模型」也走它） */
export async function setImageGenModel(gatewayId: string, model: string) {
  await useAppStore.getState().updateSettings({ imageGenGatewayId: gatewayId, imageGenModel: model });
}

export default function ImageGenPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const agents = useAppStore((s) => s.agents ?? NO_AGENTS);
  const [groups, setGroups] = useState<ImageGenGateway[] | null>(null);
  const [helperReady, setHelperReady] = useState<boolean | null>(null);
  const [skill, setSkill] = useState<SkillDto | null | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ImageGenTest | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  async function loadSkill() {
    const lib = await invoke<SkillDto[]>("list_skills").catch(() => null);
    setSkill(Array.isArray(lib) ? (lib.find((s) => s.name === "image-gen") ?? null) : null);
  }
  useEffect(() => {
    void invoke<ImageGenGateway[]>("image_gen_candidates").then(
      (r) => setGroups(Array.isArray(r) ? r : []),
      () => setGroups([]),
    );
    void invoke<{ helperReady: boolean }>("image_gen_status").then(
      (r) => setHelperReady(Boolean(r?.helperReady)),
      () => setHelperReady(false),
    );
    void loadSkill();
  }, []);

  const gatewayId = settings?.imageGenGatewayId ?? "";
  const model = settings?.imageGenModel ?? "";
  const value = gatewayId && model ? `${gatewayId}${SEP}${model}` : "";
  const listed = groups?.some((g) => g.gatewayId === gatewayId && g.models.includes(model)) ?? false;
  const savedGateway = groups?.find((g) => g.gatewayId === gatewayId);

  function choose(v: string) {
    const [gid, m] = v ? v.split(SEP) : ["", ""];
    setTest(null);
    setTestErr(null);
    void updateSettings({ imageGenGatewayId: gid, imageGenModel: m }).catch((e) => toast(`保存失败：${String(e)}`));
  }

  async function runTest() {
    if (!gatewayId || !model || testing) return;
    setTesting(true);
    setTest(null);
    setTestErr(null);
    try {
      setTest(await invoke<ImageGenTest>("image_gen_test", { gatewayId, model }));
    } catch (e) {
      setTestErr(String(e));
    } finally {
      setTesting(false);
    }
  }

  // 已装、技能目录可分发、还没打开的 Agent（与技能页「一键应用」同口径：没装的不塞副本）
  const installed = new Set(agents.filter((a) => a.binaryPath).map((a) => a.id));
  const pendingAgents = skill
    ? Object.keys(skill.apps).filter((a) => !skill.apps[a] && (agents.length === 0 || installed.has(a)))
    : [];
  const enabledAgents = skill ? Object.keys(skill.apps).filter((a) => skill.apps[a]) : [];
  const labelOf = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

  async function enableForAll() {
    if (!skill || enabling) return;
    setEnabling(true);
    try {
      for (const agent of pendingAgents) {
        await invoke("apply_skill", { id: skill.id, agent, enabled: true });
      }
      toast(`已给 ${pendingAgents.map(labelOf).join("、")} 打开出图技能`);
    } catch (e) {
      toast(`打开出图技能失败：${String(e)}`);
    } finally {
      await loadSkill();
      setEnabling(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectClass}
          aria-label="出图模型"
          title={value ? `${model} · 网关「${savedGateway?.gatewayName ?? "已删除"}」` : undefined}
          value={value}
          disabled={groups === null}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">{groups === null ? "读取中…" : "不用（Agent 不能出图）"}</option>
          {value && !listed && (
            <option value={value}>
              {model} · {savedGateway?.gatewayName ?? "网关已删除"}（目录里没有了）
            </option>
          )}
          {(groups ?? []).map((g) => (
            <optgroup key={g.gatewayId} label={g.gatewayName}>
              {g.models.map((m) => (
                <option key={m} value={`${g.gatewayId}${SEP}${m}`}>
                  {m}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className={settingsPillClass}
          disabled={!value || testing}
          onClick={() => void runTest()}
          title="按选中的模型真出一张图（会按一张图计费）"
        >
          {testing ? "出图中…" : "试出一张"}
        </button>
      </div>
      {groups !== null && groups.length === 0 && (
        <p className="mt-2 text-micro leading-4 text-l3">
          网关目录里还没有出图模型：到「网关库」给网关点一次「获取模型」，或换一个开通了出图模型的网关。
        </p>
      )}
      {testing && <p className="mt-2 text-micro text-l3">一张图常要 20 秒到 3 分钟。</p>}
      {testErr && <p className="mt-2 text-micro leading-4 text-err-text">{testErr}</p>}
      {test && (
        <div className="mt-3 flex items-start gap-3">
          <img src={test.dataUrl} alt="试出的图" className="h-28 w-auto rounded-md border border-hairline" />
          <p className="text-micro leading-4 text-l3">
            能用：{test.protocol} · {(test.elapsedMs / 1000).toFixed(1)} 秒
            {test.note ? `。${test.note}` : ""}
          </p>
        </div>
      )}
      <div className="mt-3 border-t border-hairline pt-3 text-micro leading-4 text-l3">
        {helperReady === false ? (
          <span className="text-caution-text">
            这版 Mesa 没找到随包的出图工具（mesa_helper），Agent 暂时调不了；可以先选好，装正式版后即可用。
          </span>
        ) : skill === null ? (
          <span>技能库里还没有「image-gen」，重启 Mesa 后会自动加入。</span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              在 Mesa 里启动的 Agent 打开技能「image-gen」后就能出图：
              {enabledAgents.length > 0 ? `已打开 ${enabledAgents.map(labelOf).join("、")}` : "还没给任何 Agent 打开"}
            </span>
            {pendingAgents.length > 0 && (
              <button
                type="button"
                className={settingsPillClass}
                disabled={enabling || !skill}
                onClick={() => void enableForAll()}
              >
                {enabling ? "打开中…" : "给已装的 Agent 打开"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
