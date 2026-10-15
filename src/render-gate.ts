/** 渲染闸（通用并发槽）：同一时刻最多 limit 个持槽者，超出按 FIFO 排队。
 *  为 PDF 位图重渲而设——栏收起/拖拽/缩放停稳后的换挡会让可视 ±2 页同时走
 *  「离屏画布分配 + pdf.js 绘制 + 文本层重建」，挤在同一帧就是停稳后的那一下
 *  顿挫；过闸逐页错开后，等闸页的旧位图靠 CSS 拉伸兜底（use-pdf-zoom 既有口径）。
 *  release 直接把槽位移交给队首等待者（不经过计数增减），移交瞬间不会超并发。 */

export class RenderGate {
  private readonly limit: number;
  private slots = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 取一个槽位；返回归还函数（幂等，多次调用只归还一次） */
  async acquire(): Promise<() => void> {
    if (this.slots >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
      // 槽位由 release 直接移交，不再自增
    } else {
      this.slots++;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // 移交：新持槽者醒来，计数不变
        return;
      }
      this.slots--;
    };
    return release;
  }
}
