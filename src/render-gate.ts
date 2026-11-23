/** 渲染闸（通用并发槽）：同一时刻最多 limit 个持槽者，超出按 FIFO 排队。
 *  为 PDF 位图重渲而设——栏收起/拖拽/缩放停稳后的换挡会让可视 ±2 页同时走
 *  「离屏画布分配 + pdf.js 绘制 + 文本层重建」，挤在同一帧就是停稳后的那一下
 *  顿挫；过闸逐页错开后，等闸页的旧位图靠 CSS 拉伸兜底（use-pdf-zoom 既有口径）。
 *  release 直接把槽位移交给队首等待者（不经过计数增减），移交瞬间不会超并发。 */

interface GateWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  priority?: () => number;
  cleanup?: () => void;
}

export class RenderGate {
  private readonly limit: number;
  private slots = 0;
  private waiters: GateWaiter[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 取一个槽位；返回归还函数（幂等，多次调用只归还一次）。
   *  可选 priority：释放槽位时优先唤醒返回值最小的等待者（同值仍按 FIFO）；
   *  可选 signal：排队期间中止即立刻移出队列，不再抢占渲染槽。 */
  async acquire(priority?: () => number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException("RenderGate aborted", "AbortError");
    }
    if (this.slots >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const entry: GateWaiter = { resolve, reject, priority };
        if (signal) {
          const onAbort = () => {
            const idx = this.waiters.indexOf(entry);
            if (idx >= 0) this.waiters.splice(idx, 1);
            reject(new DOMException("RenderGate aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        this.waiters.push(entry);
      });
      // 槽位由 release 直接移交，不再自增
    } else {
      this.slots++;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.waiters.length > 0) {
        let bestIdx = 0;
        let bestScore = this.waiters[0].priority?.() ?? 0;
        for (let i = 1; i < this.waiters.length; i++) {
          const score = this.waiters[i].priority?.() ?? 0;
          if (score < bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
        const [next] = this.waiters.splice(bestIdx, 1);
        next.cleanup?.();
        next.resolve(); // 移交：新持槽者醒来，计数不变
        return;
      }
      this.slots--;
    };
    return release;
  }
}
