// 测试预加载（npm test 经 --import 挂上）：断言里出现 DOM 节点时改用短描述报错。
// node:assert 生成失败信息时无视 util.inspect.custom、按 1000 层深度展开 actual / expected，
// JSDOM 节点的对象图大到格式化不完，CI 上会一路吃到内存耗尽，连带同批测试文件崩掉
// （2026-11-16 onboarding-ui 实证：Windows「Array buffer allocation failed」、macOS 被 SIGKILL）。
// 只接管任一边是 DOM 节点的 equal / strictEqual / notEqual / notStrictEqual，按「是不是同一个对象」比；其余照原样。
import assert from "node:assert/strict";

const INSTALLED = Symbol.for("mesa.domSafeAssert");

type Asserter = (actual: unknown, expected: unknown, message?: string | Error) => void;

function isDomNode(value: unknown): value is { nodeType: number; nodeName: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { nodeType?: unknown }).nodeType === "number" &&
    typeof (value as { nodeName?: unknown }).nodeName === "string"
  );
}

/** 节点的一行描述：标签 + id / aria-label + 前 40 个字；不是节点的照 String 写 */
export function describeDomValue(value: unknown): string {
  if (!isDomNode(value)) return typeof value === "string" ? JSON.stringify(value) : String(value);
  const node = value as unknown as Element;
  if (node.nodeType !== 1) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return text ? `${node.nodeName} ${JSON.stringify(text)}` : node.nodeName;
  }
  const attrs = ["id", "aria-label", "role", "name", "type"]
    .map((name) => [name, node.getAttribute(name)] as const)
    .filter(([, v]) => v)
    .map(([name, v]) => `${name}=${JSON.stringify(v)}`);
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const open = `<${node.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return text ? `${open} ${JSON.stringify(text)}` : open;
}

function wrap(name: "equal" | "strictEqual" | "notEqual" | "notStrictEqual", expectSame: boolean) {
  const original = assert[name] as Asserter;
  const patched: Asserter = function (actual, expected, message) {
    if (!isDomNode(actual) && !isDomNode(expected)) return original(actual, expected, message);
    if (Object.is(actual, expected) === expectSame) return;
    if (message instanceof Error) throw message;
    const detail = `实际 ${describeDomValue(actual)}，${expectSame ? "期望" : "不应是"} ${describeDomValue(expected)}`;
    throw new assert.AssertionError({
      message: message ? `${message}\n${detail}` : `DOM 节点${expectSame ? "不是同一个" : "不应相同"}：${detail}`,
      actual: describeDomValue(actual),
      expected: describeDomValue(expected),
      operator: expectSame ? "strictEqual" : "notStrictEqual",
      stackStartFn: patched,
    });
  };
  (assert as unknown as Record<string, Asserter>)[name] = patched;
}

if (!(globalThis as Record<symbol, unknown>)[INSTALLED]) {
  (globalThis as Record<symbol, unknown>)[INSTALLED] = true;
  wrap("equal", true);
  wrap("strictEqual", true);
  wrap("notEqual", false);
  wrap("notStrictEqual", false);
}
