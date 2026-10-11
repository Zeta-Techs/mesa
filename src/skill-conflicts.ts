import type { SkillDto } from "./types";
import { resolveSkillRefs } from "./skill-slots.ts";

/** 技能产物路径冲突检测（v3.79；2026-09-14 收口）：技能本质是 markdown 指导文件，内容级
 *  「职责重叠」无法自动判定。真冲突 = 同一路径，或两个目录互含。
 *  目录与其中一份具体文件不算覆盖（lit-search 的 papers/ 与 zotero-sync 的
 *  papers/zotero-sync.md；写作技能的 manuscript/ 与 bib-check 的 citation-check.md）。
 *  数据源 = SkillDto.outputs；未声明 outputs 的技能不参与。 */

export interface SkillOutputConflict {
  a: string;
  b: string;
  /** 相交的产物路径（取技能 a 侧声明的那条，已归一化） */
  output: string;
}

/** 归一化产物路径：去首尾空白、反斜杠统一为 /、折叠重复 /、去 ./ 前缀。目录尾斜杠保留 */
function normalizeOutput(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** 会互相覆盖的产物：同一路径，或两个目录互含。目录 vs 其中一份文件不算。 */
function outputsClash(x: string, y: string): boolean {
  const a = normalizeOutput(x);
  const b = normalizeOutput(y);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!a.endsWith("/") || !b.endsWith("/")) return false;
  return b.startsWith(a) || a.startsWith(b);
}

/** 两两比对该步骤已挂载技能的 outputs，返回产物路径相交的技能对。
 *  同一对技能多处相交只报一次（取第一对相交路径）；技能不在库中或 outputs 为空 → 不参与。 */
export function skillOutputConflicts(
  stepSkillNames: string[],
  lib: SkillDto[],
): SkillOutputConflict[] {
  const outputsOf = new Map(lib.map((s) => [s.name, s.outputs ?? []]));
  const out: SkillOutputConflict[] = [];
  for (let i = 0; i < stepSkillNames.length; i++) {
    const outsA = outputsOf.get(stepSkillNames[i]);
    if (!outsA?.length) continue;
    for (let j = i + 1; j < stepSkillNames.length; j++) {
      const outsB = outputsOf.get(stepSkillNames[j]);
      if (!outsB?.length) continue;
      const hit = outsA.find((oa) =>
        outsB.some((ob) => outputsClash(oa, ob)),
      );
      if (hit) {
        out.push({
          a: stepSkillNames[i],
          b: stepSkillNames[j],
          output: normalizeOutput(hit),
        });
      }
    }
  }
  return out;
}

// ===== 跨步骤链路校验：技能 inputs 有没有上游供给、outputs 有没有进本步骤预期产物 =====

export interface SkillChainWarning {
  skill: string;
  /** input = 读入无人供给；output = 产出未进本步骤预期产物 */
  kind: "input" | "output";
  /** 归一化后的路径 */
  path: string;
  /** 接口来自正文推断而非 frontmatter 声明（文案语气放软） */
  inferred: boolean;
}

/** 供给路径是否覆盖需求路径：相等/目录前缀互含；
 *  任一侧含 * 通配（如 notes/*.md）时：需求侧退化为 * 前静态前缀，
 *  供给侧要求落在静态前缀目录内（需求是目录时不强制扩展名后缀） */
function pathCovered(need: string, supply: string): boolean {
  let n = normalizeOutput(need);
  const s = normalizeOutput(supply);
  if (!n || !s) return true; // 空串不当缺口
  const nStar = n.indexOf("*");
  if (nStar >= 0) n = n.slice(0, nStar);
  const sStar = s.indexOf("*");
  if (sStar >= 0) {
    const prefix = s.slice(0, sStar);
    const suffix = s.slice(sStar + 1);
    if (!n.startsWith(prefix)) return false;
    return n.endsWith("/") || n.endsWith(suffix);
  }
  if (n === s) return true;
  const dirS = s.endsWith("/") ? s : `${s}/`;
  if (n.startsWith(dirS)) return true; // 供给是目录，需求在其中
  const dirN = n.endsWith("/") ? n : `${n}/`;
  return s.startsWith(dirN); // 需求是目录，供给在其中有文件
}

/** 挂载技能与流水线接口的对账：逐技能检查 inputs 有供给（上游产物/本步骤输入/项目资源，
 *  由调用方汇总成 supply）、outputs 进本步骤预期产物（expectedArtifacts 为空 = 未声明，不检）。
 *  技能不在库中或无接口声明 → 不参与；推断接口（interfaceInferred）照检但打标。 */
export function skillChainWarnings(
  stepSkillNames: string[],
  lib: SkillDto[],
  supply: string[],
  expectedArtifacts: string[],
  /** 本步合同实际要写的文件。给了就只对这批做产物检查，技能声明里别的阶段不报。 */
  stepOutputs?: string[],
): SkillChainWarning[] {
  const byName = new Map(lib.map((s) => [s.name, s]));
  const out: SkillChainWarning[] = [];
  for (const name of stepSkillNames) {
    const skill = byName.get(name);
    if (!skill) continue;
    const inferred = skill.interfaceInferred ?? false;
    for (const input of skill.inputs ?? []) {
      const producedHere = expectedArtifacts.some(
        (artifact) => pathCovered(input, artifact) || pathCovered(artifact, input),
      );
      if (producedHere) continue;
      const covered = supply.some(
        (s) => pathCovered(input, s) || pathCovered(s, input),
      );
      if (!covered) {
        out.push({
          skill: name,
          kind: "input",
          path: normalizeOutput(input),
          inferred,
        });
      }
    }
    if (expectedArtifacts.length > 0) {
      const declared = skill.outputs ?? [];
      const outputs = stepOutputs ?? declared;
      const covered = outputs.filter((output) =>
        expectedArtifacts.some(
          (a) => pathCovered(output, a) || pathCovered(a, output),
        ),
      );
      // 多阶段技能挂在其中一步时，对上了本步产物即可。
      // 调用方给了本步实际产出时，只报这一批里没进预期产物的，不拿别的阶段挡开工。
      const missing =
        stepOutputs != null
          ? outputs.filter(
              (output) =>
                !expectedArtifacts.some(
                  (a) => pathCovered(output, a) || pathCovered(a, output),
                ),
            )
          : covered.length === 0
            ? declared
            : [];
      for (const output of missing) {
        out.push({
          skill: name,
          kind: "output",
          path: normalizeOutput(output),
          inferred,
        });
      }
    }
  }
  return out;
}

/** 简报技能占位校验（2026-10-11 个性化技能机制）：{skill:锚名} 占位在步骤挂载名单里
 *  找不到占据者（provides 声明或同名都不中）→ 提醒。只提醒不拦截（守「不做事前硬门」红线）；
 *  渲染进 TASK.md 时空缺锚保留原样，agent 会看到未解析占位，本身也是显式信号。 */
export function unresolvedSkillRefs(
  brief: string,
  skills: readonly string[],
  skillLib: readonly SkillDto[] | null | undefined,
): string[] {
  const providesByName = skillLib
    ? Object.fromEntries(skillLib.map((s) => [s.name, s.provides ?? []]))
    : undefined;
  const { unresolved } = resolveSkillRefs(brief, skills, providesByName);
  return [...new Set(unresolved)];
}
