//! 聊天输入框图片标注的纯逻辑（tests/image-markup.test.ts）。
//! 标注只存在原图像素坐标里，原图不动；发送时按同一套几何画进一张新图（paintMarkup），
//! 预览（ChatImageStage 的 SVG）与导出（canvas）共用这里的线宽、徽标、箭头几何，保证所见即所发。

export type MarkTool = "box" | "pen" | "arrow" | "mask" | "crop";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Mark =
  | ({ kind: "box"; n: number } & Rect)
  | ({ kind: "mask" } & Rect)
  | ({ kind: "crop" } & Rect)
  | { kind: "pen"; points: number[] }
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number };

/** 一张附件图的标注：width/height 是原图像素尺寸，marks 按画的先后排 */
export interface Markup {
  width: number;
  height: number;
  marks: Mark[];
}

/** 标注色：系统红，配白色描边在深浅截图上都看得清 */
export const MARK_COLOR = "#ff3b30";
export const HALO_COLOR = "rgba(255,255,255,0.85)";
/** 打码是实心中灰色块：深浅截图上都看得出是遮挡（不做马赛克：马赛克能被还原） */
export const MASK_COLOR = "#5a5a5a";

/** 线宽跟图走：长边 / 500，夹在 2–12 像素，大截图上不会细得看不见 */
export function markLineWidth(width: number, height: number): number {
  return Math.min(12, Math.max(2, Math.round(Math.max(width, height) / 500)));
}

/** 两点拉出的矩形（任意方向拖都行） */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

export function clampToImage(p: { x: number; y: number }, width: number, height: number) {
  return {
    x: Math.min(width, Math.max(0, p.x)),
    y: Math.min(height, Math.max(0, p.y)),
  };
}

/** 太小的框 / 太短的箭头当成误点，不留 */
export function markTooSmall(mark: Mark, lineWidth: number): boolean {
  const min = lineWidth * 3;
  switch (mark.kind) {
    case "pen":
      return mark.points.length < 4;
    case "arrow":
      return Math.hypot(mark.x2 - mark.x1, mark.y2 - mark.y1) < lineWidth * 4;
    default:
      return mark.w < min || mark.h < min;
  }
}

/** 加一笔：裁剪框只留最后一个 */
export function addMark(marks: readonly Mark[], mark: Mark): Mark[] {
  return mark.kind === "crop"
    ? [...marks.filter((m) => m.kind !== "crop"), mark]
    : [...marks, mark];
}

export function cropOf(marks: readonly Mark[]): Rect | null {
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const m = marks[i];
    if (m.kind === "crop") return { x: m.x, y: m.y, w: m.w, h: m.h };
  }
  return null;
}

/** 导出图的尺寸与原点：有裁剪框就只要框里那块（取整、夹在图内） */
export function outputFrame(markup: Markup): Rect {
  const crop = cropOf(markup.marks);
  if (!crop) return { x: 0, y: 0, w: markup.width, h: markup.height };
  const x = Math.max(0, Math.floor(crop.x));
  const y = Math.max(0, Math.floor(crop.y));
  const right = Math.min(markup.width, Math.ceil(crop.x + crop.w));
  const bottom = Math.min(markup.height, Math.ceil(crop.y + crop.h));
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

/** 编号徽标：圆心在框的左上角，贴边时往里收，整圈都留在图内 */
export function badgeGeometry(box: Rect, lineWidth: number, width: number, height: number) {
  const r = Math.max(10, lineWidth * 4.5);
  const cx = Math.min(width - r, Math.max(r, box.x));
  const cy = Math.min(height - r, Math.max(r, box.y));
  return { cx, cy, r, fontSize: Math.round(r * 1.15) };
}

/** 箭头头部两翼：从终点往回 len、张角 ±28° */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, len: number): [number, number][] {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = (28 * Math.PI) / 180;
  return [
    [x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread)],
    [x2, y2],
    [x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread)],
  ];
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
/** 消息里引用编号用的圈码：1–20 用 ①…⑳，再往后写 (21) */
export function circledNumber(n: number): string {
  return n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
}

/** 下一个意见框编号：同一条消息里几张图连着编，不重号（撤销掉的号不回收，免得和消息里已写的对不上） */
export function nextMarkNumber(markups: readonly (Markup | undefined)[], used = 0): number {
  let max = used;
  for (const m of markups) {
    for (const mark of m?.marks ?? []) if (mark.kind === "box") max = Math.max(max, mark.n);
  }
  return max + 1;
}

/** 画了意见框后接在消息末尾的那一段：另起一行写圈码，等人接着写意见 */
export function appendMarkRef(current: string, n: number): string {
  const ref = `${circledNumber(n)} `;
  if (!current) return ref;
  return `${current.replace(/[ \t]+$/, "")}${current.endsWith("\n") ? "" : "\n"}${ref}`;
}

/** 导出格式跟原图走：jpg 还是 jpg（照片体积小），其余一律 png */
export function exportFormat(path: string): { mime: "image/png" | "image/jpeg"; ext: "png" | "jpg" } {
  return /\.jpe?g$/i.test(path) ? { mime: "image/jpeg", ext: "jpg" } : { mime: "image/png", ext: "png" };
}

/** canvas 上用到的那几个方法（测试里用记录调用的假画布） */
export interface MarkupCanvas {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  font: string;
  textAlign: string;
  textBaseline: string;
}

const BADGE_FONT = '-apple-system, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif';

/** 把原图和标注画进导出画布（画布尺寸 = outputFrame）。
 *  顺序：原图 → 打码 → 画笔 / 箭头 / 意见框（先白描边再红线）→ 编号徽标压最上。 */
export function paintMarkup(ctx: MarkupCanvas, image: unknown, markup: Markup): void {
  const frame = outputFrame(markup);
  const lw = markLineWidth(markup.width, markup.height);
  ctx.save();
  ctx.translate(-frame.x, -frame.y);
  ctx.drawImage(image, 0, 0, markup.width, markup.height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const m of markup.marks) {
    if (m.kind !== "mask") continue;
    ctx.fillStyle = MASK_COLOR;
    ctx.fillRect(m.x, m.y, m.w, m.h);
  }

  const tracePath = (m: Mark) => {
    ctx.beginPath();
    if (m.kind === "pen") {
      ctx.moveTo(m.points[0], m.points[1]);
      for (let i = 2; i + 1 < m.points.length; i += 2) ctx.lineTo(m.points[i], m.points[i + 1]);
    } else if (m.kind === "arrow") {
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      const [a, tip, b] = arrowHead(m.x1, m.y1, m.x2, m.y2, lw * 4);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.lineTo(b[0], b[1]);
    } else if (m.kind === "box") {
      ctx.rect(m.x, m.y, m.w, m.h);
    }
  };
  const strokes = markup.marks.filter((m) => m.kind === "pen" || m.kind === "arrow" || m.kind === "box");
  for (const [color, width] of [
    [HALO_COLOR, lw * 2],
    [MARK_COLOR, lw],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const m of strokes) {
      tracePath(m);
      ctx.stroke();
    }
  }

  for (const m of markup.marks) {
    if (m.kind !== "box") continue;
    const { cx, cy, r, fontSize } = badgeGeometry(m, lw, markup.width, markup.height);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = MARK_COLOR;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1.5, lw * 0.6);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${fontSize}px ${BADGE_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(m.n), cx, cy + fontSize * 0.04);
  }
  ctx.restore();
}

/** 浏览器里导出：读进原图 → 按 outputFrame 开画布 → paintMarkup → 编码成原格式的字节 */
export async function exportMarkup(
  url: string,
  path: string,
  markup: Markup,
): Promise<{ bytes: ArrayBuffer; ext: "png" | "jpg" }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const frame = outputFrame(markup);
  const canvas = document.createElement("canvas");
  canvas.width = frame.w;
  canvas.height = frame.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("没法生成标注图（画布不可用）");
  paintMarkup(ctx as unknown as MarkupCanvas, img, markup);
  const { mime, ext } = exportFormat(path);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error("没法生成标注图（编码失败）");
  return { bytes: await blob.arrayBuffer(), ext };
}
