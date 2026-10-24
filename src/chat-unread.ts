/**
 * 跑完了没看的对话（2026-10-24 用户：侧栏「都做」——几段 AI 同时在跑时，看不出哪段已经跑完、你还没去看；tests/chat-unread.test.ts）。
 * 规则：
 *   一，一段对话的这一轮从「在干活」变成「做完了」（注意力 working → done），而那一刻你没在看它（不是运行页里正看着的那段，
 *       或 Mesa 不在前台）——记一笔「没看」。等确认不算：那已经有琥珀光标。
 *   二，你看到它就消：运行页里正看着它、Mesa 在前台。
 *   三，有会话 id 的按会话记（agent + 会话 id），标签因空闲被收掉也还在，侧栏那一行照旧亮着，点开才消；
 *       还没认出会话的按标签记，认出来后挪到会话上，标签没了就丢。
 * 不跨重启（重启后进程都没了，也只回到上次那段）。侧栏的样子见 ProjectTree：标题亮到 l1。
 */

export interface UnreadRun {
  tabId: string;
  agentId: string;
  sessionId?: string | null;
  attention: "done" | "working" | "confirm" | null;
}

/** 记「没看」用的键：有会话 id 按会话，否则按标签 */
export function unreadKeyOf(r: { tabId: string; agentId: string; sessionId?: string | null }): string {
  return r.sessionId ? `${r.agentId}\n${r.sessionId}` : `tab:${r.tabId}`;
}

/** 侧栏对话行查自己有没有「没看」：会话键（列表里的那一行）或开着它的标签的键 */
export function sessionUnreadKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

export function nextUnread(input: {
  prev: readonly string[];
  /** 上一次的各标签状态（比较「这一轮刚做完」用） */
  before: readonly UnreadRun[];
  now: readonly UnreadRun[];
  /** 你此刻正看着的标签；不在运行页或 Mesa 不在前台时为 null */
  viewingTabId: string | null;
}): string[] {
  const out = new Set(input.prev);
  for (const r of input.now) {
    const b = input.before.find((x) => x.tabId === r.tabId);
    const key = unreadKeyOf(r);
    if (b) {
      const oldKey = unreadKeyOf(b);
      // 认出会话了：标签上的那一笔挪到会话上
      if (oldKey !== key && out.has(oldKey)) {
        out.delete(oldKey);
        out.add(key);
      }
      if (b.attention === "working" && r.attention === "done" && r.tabId !== input.viewingTabId) out.add(key);
    }
  }
  const viewing = input.now.find((r) => r.tabId === input.viewingTabId);
  if (viewing) {
    out.delete(unreadKeyOf(viewing));
    out.delete(`tab:${viewing.tabId}`);
  }
  // 按标签记的、标签已经没了：没有那一行可亮了
  const tabs = new Set(input.now.map((r) => r.tabId));
  for (const k of [...out]) if (k.startsWith("tab:") && !tabs.has(k.slice(4))) out.delete(k);
  return [...out];
}

export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
