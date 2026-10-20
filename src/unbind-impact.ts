// 解绑/删网关前的「会怎样」清点文案：定时任务硬绑定 fail-loud、项目与目标引用被级联清理（profiles.md §9）。
// ProfilesPage 解绑单条与 GatewayLibrary「解绑并删除」共用，口径只此一处。

export interface UnbindRefs {
  projects: number;
  goals: number;
}

export function scheduleWarnText(affected: { name: string }[]): string {
  if (affected.length === 0) return "";
  const names = affected
    .slice(0, 3)
    .map((s) => `「${s.name}」`)
    .join("、");
  return (
    `\n\n注意：有 ${affected.length} 条定时任务正在用这个配置` +
    `（${names}${affected.length > 3 ? " 等" : ""}）。` +
    `解绑后它们不会自动改用别的配置，会在下次运行时停下并提示重选连接。`
  );
}

export function usageWarnText(refs: UnbindRefs | null): string {
  if (!refs || refs.projects + refs.goals === 0) return "";
  return (
    `\n\n另有 ${refs.projects} 个项目的默认/专属绑定引用它（删除后自动清理），` +
    `${refs.goals} 条目标钉着它（删除后跟随项目默认）。`
  );
}

export function sumRefs(list: UnbindRefs[]): UnbindRefs {
  return list.reduce(
    (acc, r) => ({ projects: acc.projects + r.projects, goals: acc.goals + r.goals }),
    { projects: 0, goals: 0 },
  );
}
