// WebView2 远程调试（Chrome DevTools Protocol）的最小客户端：Node 22 自带 WebSocket / fetch，不装依赖。
// 用法（手动探查）：node scripts/win-package-smoke/cdp.mjs <端口> "<JS 表达式>"
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上 Mesa 的页面（url 以 http://tauri.localhost 或 http://127.0.0.1 / localhost 开头），等到出现为止 */
export async function connect(port, { waitMs = 60_000 } = {}) {
  const deadline = Date.now() + waitMs;
  let target = null;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && /^https?:\/\/(tauri\.localhost|127\.0\.0\.1|localhost)/.test(t.url));
    } catch {
      // 调试端口还没起来
    }
    if (!target) {
      if (Date.now() > deadline) throw new Error(`等了 ${waitMs / 1000} 秒，端口 ${port} 上没有 Mesa 页面`);
      await sleep(500);
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("连不上调试 WebSocket"));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  /** 在页面里求值（可 await），返回 JSON 值；页面抛错就抛出 */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return { target, send, on, evaluate, close: () => ws.close() };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, expr] = process.argv.slice(2);
  const c = await connect(Number(port), { waitMs: 5000 });
  console.log(JSON.stringify(await c.evaluate(expr), null, 2));
  c.close();
}
