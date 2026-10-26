/**
 * md 笔记能不能进三栏沉浸阅读（笔记｜PDF｜Agent）：问后端 reader_for_note（只读：查项目归属 + 配对本篇 PDF），
 * 配得上才显示「沉浸阅读」入口——预览右上角、项目页文件行悬停、文件树右键三处同一口径（2026-10-25 用户：
 * 没有 PDF 的文件也挂「沉浸阅读」有歧义）。结果按路径缓存一小段时间，同一路径同时只问一次，
 * 免得悬停扫过一列文件时反复打后端。PDF 本身不经这里，永远可进。
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 缓存多久（毫秒）：笔记刚写好来源行 / PDF 刚登记，半分钟后再悬停就认得出 */
export const NOTE_PAIR_TTL_MS = 30_000;

type Ask = (notePath: string) => Promise<unknown>;

const defaultAsk: Ask = (notePath) => invoke("reader_for_note", { notePath });

const cache = new Map<string, { ok: boolean; at: number }>();
const pending = new Map<string, Promise<boolean>>();

export function isMarkdownNote(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** 缓存里已有且没过期的结论；没有为 undefined */
export function cachedNotePaired(path: string, now = Date.now()): boolean | undefined {
  const hit = cache.get(path);
  return hit && now - hit.at < NOTE_PAIR_TTL_MS ? hit.ok : undefined;
}

/** 问一次能不能配上（失败 = 配不上，原因不在这里报：没有入口就不会点到） */
export function checkNotePaired(path: string, ask: Ask = defaultAsk, now = Date.now()): Promise<boolean> {
  const known = cachedNotePaired(path, now);
  if (known !== undefined) return Promise.resolve(known);
  const inflight = pending.get(path);
  if (inflight) return inflight;
  const p = ask(path)
    .then(
      () => true,
      () => false,
    )
    .then((ok) => {
      cache.set(path, { ok, at: Date.now() });
      pending.delete(path);
      return ok;
    });
  pending.set(path, p);
  return p;
}

/** 测试用：清掉缓存 */
export function resetNotePairCache(): void {
  cache.clear();
  pending.clear();
}

/** 预览里用：path 是 md 且 enabled 时去问，问到前按「配不上」处理（入口晚一点出现，不会先出来再消失） */
export function useNotePaired(path: string | null, enabled = true): boolean {
  const want = enabled && path != null && isMarkdownNote(path);
  const [ok, setOk] = useState(() => (want && path ? cachedNotePaired(path) === true : false));
  useEffect(() => {
    if (!want || !path) {
      setOk(false);
      return;
    }
    let alive = true;
    setOk(cachedNotePaired(path) === true);
    void checkNotePaired(path).then((v) => {
      if (alive) setOk(v);
    });
    return () => {
      alive = false;
    };
  }, [path, want]);
  return ok;
}
