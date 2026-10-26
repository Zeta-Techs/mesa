// 临时计时探针（量完即删）：点侧栏对话 → 各阶段 → 画到屏上，经本机 ws 报给 /tmp/switchprobe
let ws: WebSocket | null = null;
const queue: string[] = [];
let t0 = 0;
let tag = "";

function send(line: string) {
  if (!ws) {
    ws = new WebSocket("ws://127.0.0.1:17599");
    ws.onopen = () => {
      for (const q of queue.splice(0)) ws?.send(q);
    };
    ws.onclose = () => {
      ws = null;
    };
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(line);
  else queue.push(line);
}

export function probeStart(key: string) {
  t0 = performance.now();
  tag = key.replace(/\n/g, ":").slice(0, 60);
  send(`--- down ${tag}`);
}

export function probeMark(name: string, extra = "") {
  if (!t0) return;
  const at = performance.now() - t0;
  // 两次 rAF 后 ≈ 这一帧已经画出来
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      send(`${name}\t${at.toFixed(0)}ms\tpaint ${(performance.now() - t0).toFixed(0)}ms\t${extra}`);
    }),
  );
}
