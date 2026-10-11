/**
 * 技能位解析：合同占位 `{skill:锚名}` 与前端行为键的单一出处（2026-10-11 设计拍板）。
 *
 * 解析顺序（两条都显式、无推断）：
 * 1. 步骤挂载的技能里，frontmatter `provides` 声明含该锚名 → 由它顶位；
 * 2. 无人声明时回落名字精确匹配（内置技能自名即位——旧行为零回归）；
 * 3. 两者都不中 = 位空缺：占位保留锚名原样、行为键不点亮，由校验层提醒（只提醒不拦截）。
 *
 * 锚名闭集 = 内置技能名（lit-search / lit-notes / figure-forge / …），新锚进闭集须走
 * docs/conventions/pipeline.md 的拍板。引擎与本模块都不懂科研语义：谁顶位完全由
 * 技能包声明（provides）与人的挂载选择决定。
 */

/** 合同正文里的技能引用占位：{skill:lit-search} */
export const SKILL_REF_RE = /\{skill:([a-z0-9][a-z0-9-]*)\}/g;

/** 文献雷达位（定时域四处硬编码的收敛常量；自建巡检技能声明 provides: lit-watch 即点亮） */
export const LIT_WATCH_SLOT = "lit-watch";

/** 名字 → provides 声明的映射（list_skills 现算字段）。缺省/未加载 = undefined，回落名字匹配 */
export type SkillProvides = Record<string, string[]> | undefined;

/** 某技能位当前由步骤里的哪个技能占据；空缺返回 null */
export function resolveSkillSlot(
  anchor: string,
  stepSkills: readonly string[] | undefined,
  providesByName: SkillProvides,
): string | null {
  if (!stepSkills?.length) return null;
  if (providesByName) {
    for (const name of stepSkills) {
      if (providesByName[name]?.includes(anchor)) return name;
    }
  }
  return stepSkills.includes(anchor) ? anchor : null;
}

/** 步骤是否有人占据任一锚位（行为键判定用） */
export function stepFillsAnySlot(
  stepSkills: readonly string[] | undefined,
  anchors: readonly string[],
  providesByName: SkillProvides,
): boolean {
  return anchors.some((a) => resolveSkillSlot(a, stepSkills, providesByName) !== null);
}

export interface ResolvedSkillRefs {
  text: string;
  /** 没被任何挂载技能占据的锚名（校验层据此提醒，不拦截） */
  unresolved: string[];
}

/** 把简报里的 {skill:锚名} 解析成实际技能名：换技能后正文指令跟随，不再出现「本步骤技能：
 * my-search」与正文「按 lit-search 技能执行」打架。空缺锚渲染成锚名本身（可读、不把
 * 模板语法漏给 agent），锚名进 unresolved 供校验层提醒；形似占位但锚名不合法
 * （大写/中文/空格）的写法不解析、原样保留并同样进 unresolved */
export function resolveSkillRefs(
  text: string,
  stepSkills: readonly string[] | undefined,
  providesByName: SkillProvides,
): ResolvedSkillRefs {
  const unresolved: string[] = [];
  const out = text.replace(SKILL_REF_RE, (_whole, anchor: string) => {
    const hit = resolveSkillSlot(anchor, stepSkills, providesByName);
    if (hit) return hit;
    unresolved.push(anchor);
    return anchor;
  });
  for (const m of text.matchAll(/\{skill:([^}]*)\}/g)) {
    if (!SKILL_REF_RE.test(`{skill:${m[1]}}`) && !unresolved.includes(m[1])) {
      SKILL_REF_RE.lastIndex = 0;
      unresolved.push(m[1]);
    }
    SKILL_REF_RE.lastIndex = 0;
  }
  return { text: out, unresolved };
}

// ---------------------------------------------------------------------------
// provides 映射的轻量加载：模块级缓存 + 订阅失效（技能页装卸/更新后调用 invalidate）
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SkillLikeDto {
  name: string;
  provides?: string[] | null;
}

let cache: Record<string, string[]> | null = null;
let cacheAt = 0;
let generation = 0;
const listeners = new Set<() => void>();
/** 缓存 TTL：技能页外的库变更（◈ 优化开终端直改、定时草稿落库、agent 直改库文件）
 * 没有失效回调可挂——用短 TTL 把陈旧窗口限到有界（2026-10-11 复审实证：无界陈旧会让
 * ProjectGroup 的 withResearchTools 按旧映射把缺挂载的步骤持久化进 project.toml） */
const CACHE_TTL_MS = 120_000;

/** 从技能库拉名字→provides 映射（已缓存则直接返回）。并发首载单飞；
 * 失败不落缓存（下次重试），也不清掉已成功的旧快照——代数护栏防
 * 失效后旧在途响应压过新快照（2026-10-11 复审实证的竞态） */
export async function loadSkillProvides(): Promise<SkillProvides> {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const gen = generation;
  const lib = await invoke<SkillLikeDto[]>("list_skills");
  if (gen !== generation) return cache ?? undefined;
  cache = Object.fromEntries(lib.map((s) => [s.name, s.provides ?? []]));
  cacheAt = Date.now();
  return cache;
}

/** 技能库变更后失效（技能页装卸/更新/分发处调用），触发订阅组件重取 */
export function invalidateSkillProvides(): void {
  generation += 1;
  cache = null;
  cacheAt = 0;
  for (const fn of listeners) fn();
}

/** 组件用：挂载时取一次、失效时重取。未就绪 = undefined（回落名字匹配，内置行为不变） */
export function useSkillProvides(): SkillProvides {
  const [map, setMap] = useState<SkillProvides>(cache ?? undefined);
  useEffect(() => {
    let alive = true;
    const rerun = () => loadSkillProvides().then((m) => alive && setMap(m ?? undefined)).catch(() => {});
    listeners.add(rerun);
    rerun();
    return () => {
      alive = false;
      listeners.delete(rerun);
    };
  }, []);
  return map;
}
