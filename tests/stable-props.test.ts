import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  memoWithLatestFunctions,
  propsEqualIgnoringFunctions,
  sameIgnoringFunctions,
  withForwarders,
} from "../src/stable-props.ts";

test("比较时函数算相等，空数组算相等，其余只比一层", () => {
  const f = () => 1;
  const g = () => 2;
  const msgs = [{ id: 1 }];
  assert.equal(propsEqualIgnoringFunctions({ a: 1, on: f, m: msgs }, { a: 1, on: g, m: msgs }, {}), true);
  assert.equal(propsEqualIgnoringFunctions({ list: [] }, { list: [] }, {}), true);
  // 数组换了引用（哪怕内容一样）就算变了：对话列表这类数据不逐条深比
  assert.equal(propsEqualIgnoringFunctions({ m: [{ id: 1 }] }, { m: [{ id: 1 }] }, {}), false);
  assert.equal(propsEqualIgnoringFunctions({ a: 1 }, { a: 2 }, {}), false);
  // 函数 ↔ undefined 是真变化（子组件可能按有没有这个回调决定画不画按钮）
  assert.equal(propsEqualIgnoringFunctions({ on: f }, { on: undefined }, {}), false);
  assert.equal(propsEqualIgnoringFunctions({ a: 1 }, { a: 1, b: 2 }, {}), false);
});

test("指定深度的对象 / 对象数组往下比，里面的函数也算相等", () => {
  const status = { cwd: "/p" };
  const runtime = (on: () => void) => ({ status, effort: "high", onRelaunch: on });
  assert.equal(
    propsEqualIgnoringFunctions({ runtime: runtime(() => {}) }, { runtime: runtime(() => {}) }, { runtime: 2 }),
    true,
  );
  assert.equal(
    propsEqualIgnoringFunctions(
      { runtime: runtime(() => {}) },
      { runtime: { ...runtime(() => {}), effort: "low" } },
      { runtime: 2 },
    ),
    false,
  );
  const cmds = (label: string) => [{ cmd: "/new", label, run: () => {} }];
  assert.equal(sameIgnoringFunctions(cmds("新对话"), cmds("新对话"), 3), true);
  assert.equal(sameIgnoringFunctions(cmds("新对话"), cmds("另开"), 3), false);
  // 没给深度时对象换引用就算变
  assert.equal(propsEqualIgnoringFunctions({ runtime: runtime(() => {}) }, { runtime: runtime(() => {}) }, {}), false);
});

test("转发函数固定不变，调用的是最新那一版", () => {
  const cache = new Map();
  let props: Record<string, unknown> = { on: () => "旧", cfg: { run: () => "旧" } };
  const latest = () => props;
  const a = withForwarders(props.on, 1, ["on"], latest, cache) as () => string;
  const cfgA = withForwarders(props.cfg, 2, ["cfg"], latest, cache) as { run: () => string };
  props = { on: () => "新", cfg: { run: () => "新" } };
  const b = withForwarders(props.on, 1, ["on"], latest, cache) as () => string;
  assert.equal(a, b);
  assert.equal(a(), "新");
  assert.equal(cfgA.run(), "新");
  // 没有函数的容器原样返回（不打断子组件里按引用的 useMemo）
  const data = [{ id: 1 }];
  assert.equal(withForwarders(data, 3, ["m"], latest, cache), data);
});

test("父组件换闭包重画时子组件跳过；数据变了才重画，点击拿到的是最新闭包", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  const saved = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const,
  );
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true, writable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    let childRenders = 0;
    let clicked = "";
    function Child(props: { label: string; onPick: () => void; items: string[] }) {
      childRenders += 1;
      return React.createElement("button", { id: "b", onClick: props.onPick }, props.label);
    }
    const StableChild = memoWithLatestFunctions(Child);
    let bump: (n: number) => void = () => {};
    let relabel: (s: string) => void = () => {};
    function Parent() {
      const [n, setN] = React.useState(0);
      const [label, setLabel] = React.useState("甲");
      bump = setN;
      relabel = setLabel;
      return React.createElement(StableChild, {
        label,
        items: [],
        onPick: () => {
          clicked = `第${n}次`;
        },
      });
    }
    const root = createRoot(dom.window.document.getElementById("root")!);
    await React.act(async () => root.render(React.createElement(Parent)));
    assert.equal(childRenders, 1);
    await React.act(async () => bump(1));
    await React.act(async () => bump(2));
    assert.equal(childRenders, 1, "只换了闭包，子组件不重画");
    (dom.window.document.getElementById("b") as unknown as { click(): void }).click();
    assert.equal(clicked, "第2次", "跳过重画后点的仍是最新闭包");
    await React.act(async () => relabel("乙"));
    assert.equal(childRenders, 2);
    assert.equal(dom.window.document.getElementById("b")!.textContent, "乙");
    await React.act(async () => root.unmount());
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  }
});
