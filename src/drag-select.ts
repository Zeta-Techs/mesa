// 列表里按住一行往上下拖、划过的行一起勾上或去掉（对话页批量管理在用）。
// 按下那行原来没勾就整段勾上，原来勾着就整段去掉；拖回头时，退出范围的行回到按下前的样子。

/** 从 anchor 到 current（含两端，先后无关）一律设成 value，其余照 base；越界下标按两端截断 */
export function dragSelection(
  base: ReadonlySet<string>,
  keys: readonly string[],
  anchor: number,
  current: number,
  value: boolean,
): Set<string> {
  const next = new Set(base);
  if (keys.length === 0) return next;
  const clamp = (i: number) => Math.min(Math.max(i, 0), keys.length - 1);
  const from = Math.min(clamp(anchor), clamp(current));
  const to = Math.max(clamp(anchor), clamp(current));
  for (let i = from; i <= to; i += 1) {
    if (value) next.add(keys[i]);
    else next.delete(keys[i]);
  }
  return next;
}

/** 拖到列表上下边缘时每帧滚多少像素：离边越近越快，不在边缘带内为 0 */
export function edgeScrollStep(
  y: number,
  top: number,
  bottom: number,
  zone = 48,
  maxStep = 18,
): number {
  if (bottom - top <= zone * 2) return 0;
  if (y < top + zone) return -Math.ceil(maxStep * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.ceil(maxStep * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}
