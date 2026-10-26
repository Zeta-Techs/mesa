import { createElement, memo, useRef, type ComponentType } from "react";

/**
 * 「父组件每次重画都传一串新闭包」时仍能跳过重画（2026-10-26 用户「操作流畅性全部都做」）。
 * 终端页把每个标签的聊天层、状态栏都画在同一个大组件里，回调全是内联闭包；任何一个标签实时预览出一行字，
 * 所有标签的聊天层（连带整段对话）都跟着重画。`memo` 挡不住——闭包每次都是新的。
 *
 * 做法：比较时函数一律算相等，交给子组件的是按路径转发到「最新那一版」的固定函数——跳过重画后子组件手里的旧
 * props 调用的仍是父组件这一次渲染的闭包，不会拿到过期状态。`depths` 指定哪些 props 里还嵌着函数
 * （对象 2 层、对象数组 3 层），其余 props 只比一层：数组 / 对象换了引用就算变了（空数组除外，`?? []` 每次都新建）。
 */
export type NestedDepths = Readonly<Record<string, number>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sameIgnoringFunctions(x: unknown, y: unknown, depth: number): boolean {
  if (Object.is(x, y)) return true;
  if (typeof x === "function" && typeof y === "function") return true;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return false;
    if (x.length === 0) return true;
    return depth > 1 && x.every((v, i) => sameIgnoringFunctions(v, y[i], depth - 1));
  }
  if (depth > 1 && isPlainObject(x) && isPlainObject(y)) {
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    return keys.every(
      (k) => Object.prototype.hasOwnProperty.call(y, k) && sameIgnoringFunctions(x[k], y[k], depth - 1),
    );
  }
  return false;
}

export function propsEqualIgnoringFunctions(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  depths: NestedDepths,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      sameIgnoringFunctions(a[k], b[k], depths[k] ?? 1),
  );
}

type AnyFn = (...args: unknown[]) => unknown;

function readPath(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** 把 value 里的函数（按 depth 往下找）换成按路径转发到 latest() 的固定函数；没有函数的容器原样返回 */
export function withForwarders(
  value: unknown,
  depth: number,
  path: readonly (string | number)[],
  latest: () => unknown,
  cache: Map<string, AnyFn>,
): unknown {
  if (typeof value === "function") {
    const key = path.join("\u0000");
    let forward = cache.get(key);
    if (!forward) {
      forward = (...args: unknown[]) => {
        const current = readPath(latest(), path);
        return typeof current === "function" ? (current as AnyFn)(...args) : undefined;
      };
      cache.set(key, forward);
    }
    return forward;
  }
  if (depth <= 1) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, i) => {
      const next = withForwarders(item, depth - 1, [...path, i], latest, cache);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = withForwarders(v, depth - 1, [...path, k], latest, cache);
      if (next !== v) changed = true;
      out[k] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * `frozen` 为 true 时不重画（藏着的标签：记录照常刷新，但画面看不见，等露出来那一下再按最新的画一次，
 * 2026-10-26 实测四段藏着的对话每 0.7 秒各白画一遍）。`frozen` 也会传给子组件，子组件不认就忽略。
 */
export function memoWithLatestFunctions<P extends object>(
  Component: ComponentType<P>,
  depths: NestedDepths = {},
): ComponentType<P & { frozen?: boolean }> {
  const Inner = memo(Component, (a, b) => {
    if ((b as { frozen?: boolean }).frozen) return true;
    return propsEqualIgnoringFunctions(
      a as unknown as Record<string, unknown>,
      b as unknown as Record<string, unknown>,
      depths,
    );
  });
  function Stable(props: P & { frozen?: boolean }) {
    const latest = useRef(props);
    latest.current = props;
    const cache = useRef(new Map<string, AnyFn>());
    const forwarded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      forwarded[k] = withForwarders(v, depths[k] ?? 1, [k], () => latest.current, cache.current);
    }
    return createElement(Inner as ComponentType<Record<string, unknown>>, forwarded);
  }
  Stable.displayName = `Stable(${Component.displayName ?? Component.name ?? "Component"})`;
  return Stable;
}
