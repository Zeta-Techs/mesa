import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// 探出整栏（RailPeek）：去了别处就收。onClose 自己会改 store，收起动画期间组件还挂着——不能递归调自己
const bundle = await build({
  stdin: {
    contents: `export {createElement} from 'react'; export {act} from 'react'; export {createRoot} from 'react-dom/client'; export {RailPeek} from './src/components/RailPeek';`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  plugins: [
    {
      name: "store",
      setup(b) {
        b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: "store", namespace: "stub" }));
        b.onLoad({ filter: /^store$/, namespace: "stub" }, () => ({
          contents: `
            const st = () => globalThis.__peekStore;
            export const useAppStore = { getState: () => st().state, subscribe: (l) => st().subscribe(l) };`,
          loader: "js",
        }));
      },
    },
  ],
});

function makeStore() {
  const listeners = new Set<(s: any) => void>();
  const store = {
    state: { page: "terminal", terminalActiveTabId: "t1", selectProjectReq: null as string | null, railPeekOpen: true },
    subscribe(l: (s: any) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setState(p: Record<string, unknown>) {
      store.state = { ...store.state, ...p };
      [...listeners].forEach((l) => l(store.state));
    },
    listenerCount: () => listeners.size,
  };
  return store;
}

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const keep: Array<[string, PropertyDescriptor | undefined]> = [];
  const store = makeStore();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
    __peekStore: store,
  })) {
    keep.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const compiled = { exports: {} as Record<string, any> };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  const { createElement: h, act, createRoot, RailPeek } = compiled.exports;
  const root = createRoot(dom.window.document.getElementById("root")!);
  let closes = 0;
  // 和 App 一样：onClose 改 store；这里故意不重渲（最坏情形：重渲前 store 回调会被再次触发）
  const onClose = () => {
    closes += 1;
    store.setState({ railPeekOpen: false });
  };
  const render = (closing: boolean) =>
    act(async () => root.render(h(RailPeek, { left: 0, width: 300, closing, onClose }, h("div", null, "树"))));
  await render(false);
  return {
    store,
    render,
    closes: () => closes,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, d] of keep) {
        if (d) Object.defineProperty(globalThis, key, d);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("换页时只收一次：onClose 改 store 不会再触发自己（不递归、不栈溢出）", async () => {
  const v = await mount();
  try {
    v.store.setState({ page: "workbench" });
    assert.equal(v.closes(), 1);
    v.store.setState({ terminalActiveTabId: "t2" });
    assert.equal(v.closes(), 1, "已经收过，同一次探出里不再重复收");
  } finally {
    await v.close();
  }
});

test("收起动画期间不监听；半路又被叫回时拿当下的页面当基准，不会一回来就收", async () => {
  const v = await mount();
  try {
    v.store.setState({ page: "workbench" });
    assert.equal(v.closes(), 1);
    await v.render(true);
    assert.equal(v.store.listenerCount(), 0, "收起中不挂 store 监听");
    await v.render(false);
    assert.equal(v.store.listenerCount(), 1);
    v.store.setState({ railPeekOpen: true });
    assert.equal(v.closes(), 1, "重新探出后 store 没有「去了别处」的变化，不收");
    v.store.setState({ page: "sessions" });
    assert.equal(v.closes(), 2, "再换页照样收");
  } finally {
    await v.close();
  }
});
