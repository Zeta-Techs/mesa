"""聊天层第三期：按 Mesa 的启动参数（含权限四档）拉起一家 CLI，在假网关前跑三幕，逐帧记下终端画面。

  第一幕 reply：发 TRIGGER_SLOW，假网关慢慢流出 10 行 → 看实时预览能不能从屏上读（live-reply.ts）
  第二幕 tool ：发 TRIGGER_TOOL，假网关回一个「跑命令」工具调用 → 看这一档是先问还是直接放行，问的话菜单长什么样（tui-menu.ts）
  第三幕 model：发切换模型命令（第四个参数，省略则跳过）→ 看确认菜单与读回文字（reasoning-effort.ts）

用法：python3 -I chat-capture.py <计划.json> <agent> <ask|auto|full|base> <输出.json> ["/model e2e-default"]
依赖 pyte（PYTE_DIR 指向 pip --target 目录）。HOME 换临时目录并拷入本机 CLI 配置，同 terminal-keys.py，不碰真实会话目录。
Windows（2026-10-20）：走 ConPTY（pywinpty，PYWINPTY_DIR 指向 pip --target 目录，可与 PYTE_DIR 同一个），
看 Windows 上读屏兜底（审批菜单 / 实时预览）抓到的画面与 macOS 是否同形。npm 的 .cmd 垫片按 Mesa 同口径直启（原生 exe / node + js）。
"""
import base64, json, os, re, shutil, signal, sys, tempfile, time
sys.path.insert(0, os.environ.get("PYTE_DIR", ""))
import pyte
WIN = os.name == "nt"
if WIN:
    import queue, threading
    sys.path.insert(0, os.environ.get("PYWINPTY_DIR", ""))
    from winpty import PtyProcess
else:
    import pty, select, fcntl, termios, struct
_rds = pyte.Screen.report_device_status
pyte.Screen.report_device_status = lambda self, *a, **k: _rds(self, *a)
_sgr = pyte.Screen.select_graphic_rendition  # Gemini 发带私有参数的 SGR，pyte 0.8 不认 private 关键字
pyte.Screen.select_graphic_rendition = lambda self, *a, **k: _sgr(self, *a)

plans = json.load(open(sys.argv[1])); agent = sys.argv[2]; tier = sys.argv[3]; out_path = sys.argv[4]
switch_cmd = sys.argv[5] if len(sys.argv) > 5 else None
real_home = os.path.expanduser("~")
BIN = {"claude-code": "claude", "codebuddy": "codebuddy", "codex": "codex", "qwen": "qwen",
       "kimi": os.path.join(real_home, ".kimi-code/bin/kimi"), "opencode": "opencode", "grok": "grok",
       "gemini": "gemini", "cursor": "cursor-agent"}
COPY = [".claude/settings.json", ".claude.json", ".codex/config.toml", ".grok/config.toml", ".qwen/settings.json",
        ".kimi-code/config.toml", ".config/opencode/opencode.json", ".gemini/settings.json", ".codebuddy/settings.json"]
plan = plans[agent]
a = list(plan["args"] if tier == "base" else plan["permission"][tier])
# Claude 的连接（网关地址、钥匙、模型）全在 --settings 文件里。文件不在了（Mesa 会清理 external-launch 下的旧文件）
# 就停下：去掉参数会落回拷进来的本机 settings.json，请求打到真实网关、用的是真钥匙（2026-10-18 踩过一次）
if "--settings" in a and not os.path.exists(a[a.index("--settings") + 1]):
    sys.exit(f"{agent}: 启动计划里的 --settings 文件已不在，请重新生成计划（cargo test e2e_dump_launch_plans）后马上跑")
home = tempfile.mkdtemp(prefix=f"cc-{agent}-"); os.chmod(home, 0o700)
# CLEAN_HOME=1（CLI 金丝雀）：不拷本机配置，只预置 Claude「已走完首次引导」——各台机器、CI 抓到的画面才可比
CLEAN = bool(os.environ.get("CLEAN_HOME"))
for rel in [] if CLEAN else COPY:
    src = os.path.join(real_home, rel)
    if os.path.exists(src):
        dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
work = os.path.join(home, "work"); os.makedirs(work)
if CLEAN:
    json.dump({"hasCompletedOnboarding": True, "projects": {}}, open(os.path.join(home, ".claude.json"), "w"))
# Gemini：Mesa 只在本机设置选的是 API Key 登录时才放行第三方连接（gemini_auth_blocker），临时 HOME 里照这个口径改
gs = os.path.join(home, ".gemini/settings.json")
if agent == "gemini":
    os.makedirs(os.path.dirname(gs), exist_ok=True)
    g = json.load(open(gs)) if os.path.exists(gs) else {}
    g.setdefault("security", {}).setdefault("auth", {})["selectedType"] = "gemini-api-key"
    json.dump(g, open(gs, "w"))
cj = os.path.join(home, ".claude.json")
if os.path.exists(cj):
    d = json.load(open(cj)); d.setdefault("projects", {})
    # Windows 上 Claude 用正斜杠路径作键
    for w in {work, os.path.realpath(work), work.replace("\\", "/")}: d["projects"][w] = {"hasTrustDialogAccepted": True}
    json.dump(d, open(cj, "w"))
# 第三幕之后看 CLI 有没有把切换写回它自己的全局配置（Claude /model 会写 settings.json）：先记一份拷进来并按 Mesa 口径改过之后的样子
before = {}
for rel in COPY:
    f = os.path.join(home, rel)
    if os.path.exists(f): before[rel] = open(f, encoding="utf-8", errors="replace").read()
env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_", "GHOSTTY", "TERM", "LC_TERMINAL")) and k not in ("CLAUDECODE", "COLORTERM")}
env.update(HOME=home, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1", TERM="xterm-256color", COLORTERM="truecolor",
           TERM_PROGRAM="Mesa", GEMINI_CLI_TRUST_WORKSPACE="true")
if WIN:
    env["USERPROFILE"] = home  # Windows 上 CLI 的「家目录」看 USERPROFILE
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"): env.pop(k, None)
for k in plan.get("env_remove", []): env.pop(k, None)
for k, v in plan["env"]: env[k] = v
# CAP_ENV="K=V;K2=V2"：再加几个环境变量（上面把 CLAUDE_CODE_* 都去掉了，要开 Claude 的某个开关从这里给，
# 如 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1——「猜下一句」平时要服务端开关，假网关下拿不到）
for pair in filter(None, os.environ.get("CAP_ENV", "").split(";")):
    k, _, v = pair.partition("="); env[k] = v
COLS, ROWS = int(os.environ.get("CAP_COLS", "120")), int(os.environ.get("CAP_ROWS", "40"))
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)


def win_argv(binary, args):
    """Windows：npm 的 .cmd 垫片同 Mesa（process.rs）直启——指向原生 exe 的直启 exe，指向 js 的用 node 跑"""
    path = shutil.which(binary) or binary
    if not path.lower().endswith((".cmd", ".bat")):
        return [path, *args]
    text = open(path, encoding="utf-8", errors="replace").read()
    targets = [t.replace("/", "\\") for t in re.findall(r'%~?dp0%?[\\/]([^"\s]+)', text)]
    base = os.path.dirname(path)
    js = [t for t in targets if t.lower().endswith(".js")]
    exe = [t for t in targets if t.lower().endswith(".exe") and t.lower() != "node.exe"]
    if js:
        node = os.path.join(base, "node.exe")
        return [node if os.path.exists(node) else (shutil.which("node") or "node"), os.path.join(base, js[-1]), *args]
    if exe:
        return [os.path.join(base, exe[-1]), *args]
    bare = [t for t in targets if t.lower() != "node.exe" and "." not in os.path.basename(t)]
    if bare:  # CodeBuddy：无扩展名的 node 脚本
        return [shutil.which("node") or "node", os.path.join(base, bare[-1]), *args]
    return ["cmd.exe", "/d", "/c", "call", path, *args]


if WIN:
    proc = PtyProcess.spawn(win_argv(BIN[agent], a), cwd=work, env=env, dimensions=(ROWS, COLS))
    inbox = queue.Queue()

    def _reader():
        while True:
            try:
                data = proc.read(65536)
            except Exception:
                inbox.put(None); return
            if data:
                inbox.put(data.encode("utf-8", "surrogateescape") if isinstance(data, str) else data)

    threading.Thread(target=_reader, daemon=True).start()

    def pty_read(timeout):
        try:
            data = inbox.get(timeout=timeout)
        except queue.Empty:
            return b""
        if data is None:
            raise OSError("pty closed")
        return data

    def pty_write(data):
        # pywinpty 在子进程退出后写入抛 EOFError（不是 OSError）：统一成 OSError，各处按「CLI 已退出」收尾
        try:
            proc.write(data.decode("utf-8", "surrogateescape"))
        except EOFError as e:
            raise OSError(str(e)) from e
else:
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work); os.execvpe(shutil.which(BIN[agent]) or BIN[agent], [BIN[agent], *a], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def pty_read(timeout):
        r, _, _ = select.select([fd], [], [], timeout)
        return os.read(fd, 65536) if r else b""

    def pty_write(data):
        os.write(fd, data)
kitty = [False]; alive = [True]; paste = [False]; focus = [False]
# CAP_RAW=1：终端原始输出逐块记进结果的 raw（[秒, base64]），拿真 xterm.js 回放（live-replay.ts）看读屏在每一块之间读到什么
RAW, T0 = [] if os.environ.get("CAP_RAW") else None, time.time()


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        try: data = pty_read(0.05)
        except OSError:
            alive[0] = False; return
        if not data: continue
        if RAW is not None: RAW.append([round(time.time() - T0, 3), base64.b64encode(data).decode()])
        # 子进程开 / 关 bracketed paste（同 pty.rs 的检测口径）：Windows 上要看 ConPTY 有没有把它转出来
        if b"\x1b[?2004h" in data: paste[0] = True
        if b"\x1b[?2004l" in data: paste[0] = False
        # 焦点上报（mode 1004）：开了之后 xterm.js 在终端失焦 / 得焦时发 ESC[O / ESC[I
        if b"\x1b[?1004h" in data: focus[0] = True
        if b"\x1b[?1004l" in data: focus[0] = False
        # 应答口径同 src/terminal-protocols.ts（DA1 / XTVERSION / kitty 查询 / DECRQM / DSR / OSC 10/11）
        for m in re.finditer(rb"\x1b\[(0?c|>0?q|\?u|>4;\?m|\?(\d+)\$p|\??6n|>(\d*)u|<(\d*)u)|\x1b\](1[01]);\?(\x07|\x1b\\)", data):
            q = m.group(0)
            if q in (b"\x1b[c", b"\x1b[0c"): pty_write(b"\x1b[?1;2c")
            elif q in (b"\x1b[>q", b"\x1b[>0q"): pty_write(b"\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\")
            elif q == b"\x1b[?u": pty_write(b"\x1b[?5u")
            elif q == b"\x1b[>4;?m": pty_write(b"\x1b[>4;0m")
            elif q.endswith(b"$p"): pty_write(b"\x1b[?%s;2$y" % m.group(2))
            elif q.endswith(b"6n"): pty_write(b"\x1b[%d;%dR" % (screen.cursor.y + 1, screen.cursor.x + 1))
            elif m.group(3) is not None: kitty[0] = int(m.group(3) or 0) != 0
            elif m.group(4) is not None: kitty[0] = False
            elif m.group(5): pty_write(b"\x1b]%s;rgb:2828/2c2c/3434\x1b\\" % m.group(5))
        # pyte 不认 APC（kitty 图形查询 ESC _G…ESC \），会当正文画出来；xterm.js 直接忽略，这里同样剥掉
        stream.feed(re.sub(rb"\x1b_[^\x1b]*\x1b\\", b"", data))


def lines():
    # 不用 screen.display：遇到零宽字符后的空格子 pyte 0.8 会 IndexError；宽字符第二格本来就是空串，直接拼即可
    return ["".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip() for y in range(screen.lines)]


def send(text, submit=True):
    if not alive[0]: return
    try:
        # 同 Mesa 聊天发送（pty_write_submit）：正文后跟提交键；kitty 推上来时 Enter 走 CSI-u；
        # 多行且子进程开了 bracketed paste 才包成一次粘贴（pty.rs wrap_bracketed_paste）。REPLY_PROMPT 里写 \n 可测多行
        body = text.replace("\\n", "\n").encode()
        if paste[0] and b"\n" in body: body = b"\x1b[200~" + body + b"\x1b[201~"
        pty_write(body)
        pump(0.4)
        if submit: pty_write(b"\x1b[13u" if kitty[0] else b"\r")
    except OSError:
        alive[0] = False


def film(sec, step=0.4):
    """sec 秒内每 step 秒拍一帧，画面没变就不记"""
    frames, last, t0 = [], None, time.time()
    while time.time() - t0 < sec and alive[0]:
        pump(step)
        cur = lines()
        if cur != last:
            frames.append({"t": round(time.time() - t0, 1), "lines": cur}); last = cur
    return frames


record = {"agent": agent, "tier": tier, "args": a, "scenes": {}}
record["scenes"]["startup"] = film(9, 0.6)
# 一次性对话框：照原文记下后放行（信任目录选默认；Claude 完全访问警告选「Yes, I accept」——抓屏是看形态，不是替用户选）
for _ in range(4):
    rows = lines()
    try:
        if any("Yes, I accept" in r for r in rows):
            pty_write(b"\x1b[B"); pump(0.3); pty_write(b"\x1b[13u" if kitty[0] else b"\r"); pump(2.5)
        elif any(re.search(r"trust this folder|trust folder only|do you trust", r, re.I) for r in rows):
            pty_write(b"\x1b[13u" if kitty[0] else b"\r"); pump(2.5)
        elif any("Try the new fullscreen renderer" in r for r in rows):
            # Claude 2.1.30x 拿拷来的配置起时会推「全屏渲染」：默认选 Not now（用户本机是普通渲染）；CAP_FULLSCREEN=1 选 Yes
            if not os.environ.get("CAP_FULLSCREEN"): pty_write(b"\x1b[B"); pump(0.3)
            pty_write(b"\x1b[13u" if kitty[0] else b"\r"); pump(2.5)
        elif any("Make auto mode" in r for r in rows):
            pty_write(b"\x1b[27u" if kitty[0] else b"\x1b"); pump(1.5)
    except OSError:
        break
record["scenes"]["ready"] = [{"t": 0, "lines": lines()}]
# CAP_FOCUS=out / in：开场后告诉 CLI 终端失焦 / 得焦（Mesa 聊天层盖住终端时 xterm.js 的输入区是失焦的），看它还出不出「猜下一句」
if os.environ.get("CAP_FOCUS") and focus[0]:
    pty_write(b"\x1b[O" if os.environ["CAP_FOCUS"] == "out" else b"\x1b[I"); pump(0.5)

# 生成中再发一句（2026-10-22，聊天层「排队 / 立即发送」）：先发 QUEUE_FIRST 让它干活（默认 TRIGGER_TOOL，配合
# E2E_PROBE_CMD="sleep 8; …" 让工具跑久一点），过 QUEUE_AFTER 秒再打 QUEUE_PROMPT、按 QUEUE_KEY（默认回车；Codex 的 Tab 写 \t），
# 拍 QUEUE_SECS 秒。这句话是插进这一轮、排到这一轮后、还是打断这一轮，看假网关 E2E_DUMP 里它出现在哪个请求
if os.environ.get("QUEUE_PROMPT"):
    send(os.environ.get("QUEUE_FIRST", "TRIGGER_TOOL 跑一下"))
    record["scenes"]["queue_before"] = film(float(os.environ.get("QUEUE_AFTER", "3")))
    try:
        pty_write(os.environ["QUEUE_PROMPT"].encode())
        pump(0.4)
        record["scenes"]["queue_typed"] = [{"t": 0, "lines": lines()}]
        key = os.environ.get("QUEUE_KEY")
        pty_write(key.encode().decode("unicode_escape").encode() if key else (b"\x1b[13u" if kitty[0] else b"\r"))
        # QUEUE_THEN：排上之后再按的键（如 Claude 提示的 ctrl+enter「现在就发」：kitty 下是 \x1b[13;5u），隔 QUEUE_THEN_AFTER 秒
        then = os.environ.get("QUEUE_THEN")
        if then:
            record["scenes"]["queue_queued"] = film(float(os.environ.get("QUEUE_THEN_AFTER", "1.5")), 0.3)
            pty_write(then.encode().decode("unicode_escape").encode())
    except OSError:
        alive[0] = False
    record["scenes"]["queue_after"] = film(float(os.environ.get("QUEUE_SECS", "25")), 0.5)
    record["probe_created"] = os.path.exists(os.path.join(work, "mesa_probe.txt"))
    record["kitty"] = kitty[0]; record["alive"] = alive[0]
    json.dump(record, open(out_path, "w"), ensure_ascii=False, indent=1)
    try: proc.terminate(force=True) if WIN else os.kill(pid, signal.SIGKILL)
    except OSError: pass
    shutil.rmtree(home, ignore_errors=True)
    print(f"{agent}/{tier}: queue probe_created={record['probe_created']} kitty={kitty[0]} alive={alive[0]}")
    sys.exit(0)

send(os.environ.get("REPLY_PROMPT", "TRIGGER_SLOW 讲一段"))
record["scenes"]["reply"] = film(float(os.environ.get("REPLY_SECS", "12")))
pump(1)

probe = os.path.join(work, "mesa_probe.txt")
send(os.environ.get("TOOL_PROMPT", "TRIGGER_TOOL 跑一下"))
record["scenes"]["tool"] = film(float(os.environ.get("TOOL_SECS", "10")), 0.5)
record["probe_created"] = os.path.exists(probe)
# APPROVE_KEYS：审批停着时按这串键（如 y、1、回车），看聊天层的「批准」按钮按哪个键才管用
approve = os.environ.get("APPROVE_KEYS")
if approve and not record["probe_created"] and alive[0]:
    # 用 | 分开的每个键单独写、隔 APPROVE_GAP 秒（默认 0.1，同 Mesa answerMenu：Ink 一次只认一个键），每按一个记一帧（approve_steps）
    # 「:文字」= 原样打一段字（如 Claude 提问菜单的「Type something.」那一项里写答案）
    gap = float(os.environ.get("APPROVE_GAP", "0.1"))
    steps = []
    for key in approve.split("|"):
        try: pty_write(key[1:].encode() if key.startswith(":") else key.encode().decode("unicode_escape").encode())
        except OSError: break
        pump(gap)
        steps.append({"key": key, "lines": lines()})
    record["scenes"]["approve_steps"] = steps
    record["scenes"]["approve"] = film(6, 0.5)
    record["approved_by"] = approve
    record["probe_created"] = os.path.exists(probe)
if not record["probe_created"] and alive[0]:
    # 停在审批上：按 Esc 取消，免得挡住下一幕
    try: pty_write(b"\x1b[27u" if kitty[0] else b"\x1b")
    except OSError: pass
    pump(2)

if switch_cmd and alive[0]:
    send(switch_cmd)
    record["scenes"]["model"] = film(7)

if switch_cmd and alive[0] and os.environ.get("ANSWER_MENU"):
    # 切换弹确认时按下回车选默认项（Claude「Yes, switch」），再等几秒看配置有没有被写
    # ANSWER_MENU=2：连按两次（Codex 选完模型还要选思考档）
    for _ in range(int(os.environ.get("ANSWER_MENU", "1") or 1)):
        try: pty_write(b"\x1b[13u" if kitty[0] else b"\r")
        except OSError: pass
        pump(1.5)
    record["scenes"]["model_after"] = film(5)
import difflib
changed = {}
for rel in COPY + [".gemini/settings.json", ".grok/config.toml", ".qwen/settings.json", ".kimi-code/config.toml", ".codex/config.toml"]:
    f = os.path.join(home, rel)
    if not os.path.exists(f): continue
    now = open(f, encoding="utf-8", errors="replace").read()
    if now != before.get(rel):
        changed[rel] = "".join(difflib.unified_diff((before.get(rel) or "").splitlines(True), now.splitlines(True), n=0))[:1500]
record["config_changed"] = changed
record["kitty"] = kitty[0]; record["alive"] = alive[0]; record["bracketed_paste"] = paste[0]; record["focus_reporting"] = focus[0]
if RAW is not None: record["raw"] = RAW; record["size"] = [COLS, ROWS]
json.dump(record, open(out_path, "w"), ensure_ascii=False, indent=1)
try: proc.terminate(force=True) if WIN else os.kill(pid, signal.SIGKILL)
except OSError: pass
shutil.rmtree(home, ignore_errors=True)
for rel, d in changed.items(): print(f"--- {rel} 被改了：\n{d}")
print(f"{agent}/{tier}: probe_created={record['probe_created']} kitty={kitty[0]} alive={alive[0]} "
      f"frames={ {k: len(v) for k, v in record['scenes'].items()} }")
