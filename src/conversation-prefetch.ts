/**
 * 点开对话前先备好料（2026-10-24 用户：侧栏切对话没有 Claude 客户端那样点了就出来）。
 * 鼠标移到对话行上就去取两样东西，点下去时多半已经回来了：
 * - 接回要用的 Run 身份与上次的模型 / 思考档（quick-chat-launch.ts 点开前要等它）：只用一次、10 秒过期——
 *   Run 在发第一句后才登记，留久了会拿旧的「没有 Run」开出一条分裂的新 Run；
 * - 摆出来看的最近一页记录（TerminalPage 只看不接的标签）：按会话的更新时间认，没变就直接用，
 *   来回切同几段对话不再每次重读。
 * 取数函数由调用方给，本模块只管缓存规则（可单测）。
 */

export const RESUME_LOOKUP_TTL_MS = 10_000;
/** 记录页最多留几段（每段几十条消息） */
export const PAGE_CACHE_LIMIT = 24;
/** 整段里更早的那部分最多留几段（大的一段几 MB，留最近看过的几段够来回切） */
export const REST_CACHE_LIMIT = 8;

type Clock = () => number;

/** 用一次就扔、过期作废的预取（接回身份） */
export class OneShotPrefetch<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  private ttlMs: number;
  private now: Clock;
  // 不用构造参数属性：node --test 只剥类型，不认这种要转换的写法
  constructor(ttlMs: number, now: Clock = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }
  prefetch(key: string, load: () => Promise<T>): void {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return;
    this.entries.set(key, { at: this.now(), value: load() });
  }
  /** 有新鲜的就拿走（之后不再给），没有就现取 */
  take(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    return load();
  }
}

/** 按版本认的结果缓存（记录页）：版本一样就复用，取失败的不留；超过上限扔最久没用的 */
export class VersionedCache<T> {
  private entries = new Map<string, { version: string; value: Promise<T>; done?: { v: T } }>();
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get(key: string, version: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.version === version) {
      // 挪到最后＝最近用过
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = load();
    const entry: { version: string; value: Promise<T>; done?: { v: T } } = { version, value };
    this.entries.set(key, entry);
    value.then(
      (v) => {
        entry.done = { v };
      },
      () => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key);
      },
    );
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  /**
   * 已经取回来的现成结果（版本一样才算），没有或还在取就 undefined。切到一段看过 / 鼠标移上去时已取过的对话，
   * 第一帧就能把记录摆出来，不先画一帧空白（2026-10-26 用户：切对话黑一下）
   */
  peek(key: string, version: string): T | undefined {
    const hit = this.entries.get(key);
    return hit && hit.version === version ? hit.done?.v : undefined;
  }
}
