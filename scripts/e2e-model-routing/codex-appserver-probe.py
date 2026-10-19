"""Codex 结构化旁路试验（docs/design-chat-structured-channels.md §8.5）：私有 app-server + TUI `--remote` + Mesa 作为第二个客户端。

  1. 拉一个 `codex app-server --listen unix://<sock>`（带 Mesa 启动计划里的 -c 注入与环境变量）
  2. PTY 里拉 TUI：`codex --remote unix://<sock>`
  3. 另起 `codex app-server proxy --sock <sock>` 当 Mesa 客户端：initialize → 轮询 thread/loaded/list →
     thread/resume 加入 TUI 的线程 → 记下收到的通知与服务端请求；收到审批请求时由本客户端批准，看 TUI 那边是否跟着撤菜单

用法：python3 -I codex-appserver-probe.py <计划.json> <输出.json>
同 chat-capture.py：HOME 换临时目录并拷入本机 Codex 配置，只打本机假网关。
"""
import json, os, pty, queue, re, select, shutil, signal, subprocess, sys, tempfile, threading, time, fcntl, termios, struct

plans = json.load(open(sys.argv[1])); out_path = sys.argv[2]
plan = plans["codex"]
real_home = os.path.expanduser("~")
home = tempfile.mkdtemp(prefix="cx-"); os.chmod(home, 0o700)
for rel in (".codex/config.toml",):
    src = os.path.join(real_home, rel)
    if os.path.exists(src):
        dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
work = os.path.join(home, "work"); os.makedirs(work)
sock = os.path.join(home, "codex.sock")
env = {k: v for k, v in os.environ.items() if not k.startswith(("GHOSTTY", "TERM", "LC_TERMINAL")) and k != "COLORTERM"}
env.update(HOME=home, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1", TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="Mesa")
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"): env.pop(k, None)
for k in plan.get("env_remove", []): env.pop(k, None)
for k, v in plan["env"]: env[k] = v
codex = shutil.which("codex")
# 计划里 -c 成对出现的是配置注入，其余（--no-daemon、模型目录等）只给 TUI
cfg, rest, a = [], [], list(plan["permission"].get("ask") or plan["args"])
i = 0
while i < len(a):
    if a[i] in ("-c", "--config") and i + 1 < len(a): cfg += a[i:i + 2]; i += 2
    else: rest.append(a[i]); i += 1
record = {"cfg": cfg, "tui_rest": rest}

# TRANSPORT=ws：改用本机 TCP WebSocket + 能力令牌（Windows 没有 unix socket 时的同一条路；令牌只经环境变量给 TUI，
# app-server 参数里只有它的 SHA-256）
import hashlib, secrets, socket as _sk
use_ws = os.environ.get("TRANSPORT") == "ws"
token = secrets.token_urlsafe(32)
if use_ws:
    _s = _sk.socket(); _s.bind(("127.0.0.1", 0)); port = _s.getsockname()[1]; _s.close()
    listen = [f"ws://127.0.0.1:{port}", "--ws-auth", "capability-token", "--ws-token-sha256", hashlib.sha256(token.encode()).hexdigest()]
    env["MESA_CODEX_TOKEN"] = token
else:
    listen = [f"unix://{sock}"]
server = subprocess.Popen([codex, "app-server", "--listen", *listen, *cfg], cwd=work, env=env,
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(os.path.join(home, "server.err"), "w"))
def ready():
    if not use_ws: return os.path.exists(sock)
    try: c = _sk.create_connection(("127.0.0.1", port), 0.2); c.close(); return True
    except OSError: return False
for _ in range(100):
    if ready(): break
    time.sleep(0.1)
record["socket_ready"] = ready()

remote = [f"ws://127.0.0.1:{port}", "--remote-auth-token-env", "MESA_CODEX_TOKEN"] if use_ws else [f"unix://{sock}"]
tui_args = ["--remote", *remote, *[x for x in rest if x != "--no-daemon"]]
record["tui_args"] = tui_args
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe(codex, [codex, *tui_args], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
raw = bytearray(); alive = [True]; kitty = [False]
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b.")


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r: continue
        try: data = os.read(fd, 65536)
        except OSError: alive[0] = False; return
        for m in re.finditer(rb"\x1b\[(0?c|>0?q|\?u|\??6n|>(\d*)u)|\x1b\](1[01]);\?(\x07|\x1b\\)", data):
            q = m.group(0)
            if q in (b"\x1b[c", b"\x1b[0c"): os.write(fd, b"\x1b[?1;2c")
            elif q in (b"\x1b[>q", b"\x1b[>0q"): os.write(fd, b"\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\")
            elif q == b"\x1b[?u": os.write(fd, b"\x1b[?5u")
            elif q.endswith(b"6n"): os.write(fd, b"\x1b[1;1R")
            elif m.group(2) is not None: kitty[0] = int(m.group(2) or 0) != 0
            elif m.group(3): os.write(fd, b"\x1b]%s;rgb:2828/2c2c/3434\x1b\\" % m.group(3))
        raw.extend(data)


def text(n=4000):
    return ANSI.sub(b" ", bytes(raw[-n:])).decode("utf-8", "replace")


def enter():
    os.write(fd, b"\x1b[13u" if kitty[0] else b"\r")


# Mesa 客户端：unix socket 上是 WebSocket（握手 GET /rpc → 101），每条 JSON-RPC 一帧文本
import base64, socket
if use_ws:
    ws = socket.create_connection(("127.0.0.1", port))
    auth = f"Authorization: Bearer {token}\r\n"
else:
    ws = socket.socket(socket.AF_UNIX); ws.connect(sock); auth = ""
ws.sendall(("GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n%s"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (auth, base64.b64encode(os.urandom(16)).decode())).encode())
hs = b""
while b"\r\n\r\n" not in hs: hs += ws.recv(1)
record["ws_handshake"] = hs.split(b"\r\n")[0].decode()
inbox = queue.Queue(); log = []
wlock = threading.Lock()


def ws_send(obj):
    data = json.dumps(obj).encode(); mask = os.urandom(4)
    head = bytearray([0x81])
    n = len(data)
    if n < 126: head.append(0x80 | n)
    elif n < 65536: head.append(0x80 | 126); head += n.to_bytes(2, "big")
    else: head.append(0x80 | 127); head += n.to_bytes(8, "big")
    with wlock: ws.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def recv_exact(n):
    buf = b""
    while len(buf) < n:
        chunk = ws.recv(n - len(buf))
        if not chunk: raise EOFError
        buf += chunk
    return buf


def reader():
    frag = b""
    try:
        while True:
            b1, b2 = recv_exact(2)
            n = b2 & 0x7F
            if n == 126: n = int.from_bytes(recv_exact(2), "big")
            elif n == 127: n = int.from_bytes(recv_exact(8), "big")
            payload = recv_exact(n)
            op = b1 & 0x0F
            if op == 0x9: continue
            if op in (0x1, 0x0):
                frag += payload
                if b1 & 0x80:
                    try: inbox.put(json.loads(frag))
                    except Exception: pass
                    frag = b""
            if op == 0x8: return
    except Exception:
        return


threading.Thread(target=reader, daemon=True).start()
nid = [0]


def call(method, params=None, timeout=10):
    nid[0] += 1; rid = nid[0]
    ws_send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    end = time.time() + timeout
    while time.time() < end:
        try: m = inbox.get(timeout=0.2)
        except queue.Empty: continue
        if m.get("id") == rid and "method" not in m: return m
        log.append(m)
    return {"error": "timeout"}


def notify(method, params=None):
    ws_send({"jsonrpc": "2.0", "method": method, "params": params or {}})


record["initialize"] = call("initialize", {"clientInfo": {"name": "mesa-probe", "version": "0.0.1"}})
notify("initialized")
pump(8)
for _ in range(3):
    t = text()
    if "Trust" in t or "trust" in t: enter(); pump(2)
raw.clear()
os.write(fd, "TRIGGER_TOOL TRIGGER_ESC 跑一下".encode()); pump(0.4); enter()

thread_id = None; t0 = time.time()
while time.time() - t0 < 15 and not thread_id:
    pump(0.5)
    r = call("thread/loaded/list", {}, 3)
    ids = (r.get("result") or {}).get("data") or (r.get("result") or {}).get("threadIds") or []
    record["loaded_list_raw"] = r
    if ids:
        thread_id = ids[0] if isinstance(ids[0], str) else ids[0].get("id")
record["thread_id"] = thread_id
if thread_id:
    record["resume"] = {k: v for k, v in call("thread/resume", {"threadId": thread_id}, 10).items() if k != "result"} or "ok"

approved_via_client = None; t0 = time.time()
probe = os.path.join(work, "mesa_probe.txt")
while time.time() - t0 < 40:
    pump(0.3)
    try:
        while True:
            m = inbox.get_nowait(); log.append(m)
            if "method" in m and "id" in m and "requestApproval" in m["method"] and approved_via_client is None:
                ws_send({"jsonrpc": "2.0", "id": m["id"], "result": {"decision": "accept"}}); approved_via_client = m["method"]
    except queue.Empty:
        pass
    if os.path.exists(probe) and time.time() - t0 > 6: break
pump(3)
kinds = []
for m in log:
    k = ("请求 " if "id" in m and "method" in m else "") + m.get("method", "响应")
    if not kinds or kinds[-1][0] != k: kinds.append([k, 1])
    else: kinds[-1][1] += 1
record["mesa_client_saw"] = kinds
record["approved_via_client"] = approved_via_client
record["probe_created"] = os.path.exists(probe)
record["tui_tail"] = text(3000)[-1200:]
record["server_err"] = open(os.path.join(home, "server.err"), errors="replace").read()[-800:]
json.dump(record, open(out_path, "w"), ensure_ascii=False, indent=1)
for p in (server,):
    try: p.kill()
    except Exception: pass
try: os.kill(pid, signal.SIGKILL)
except OSError: pass
shutil.rmtree(home, ignore_errors=True)
print(json.dumps({k: record.get(k) for k in ("socket_ready", "thread_id", "approved_via_client", "probe_created")}, ensure_ascii=False))
print("Mesa 客户端收到：", kinds)
