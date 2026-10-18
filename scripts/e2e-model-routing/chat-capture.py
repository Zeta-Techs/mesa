"""聊天层第三期：按 Mesa 的启动参数（含权限四档）拉起一家 CLI，在假网关前跑三幕，逐帧记下终端画面。

  第一幕 reply：发 TRIGGER_SLOW，假网关慢慢流出 10 行 → 看实时预览能不能从屏上读（live-reply.ts）
  第二幕 tool ：发 TRIGGER_TOOL，假网关回一个「跑命令」工具调用 → 看这一档是先问还是直接放行，问的话菜单长什么样（tui-menu.ts）
  第三幕 model：发切换模型命令（第四个参数，省略则跳过）→ 看确认菜单与读回文字（reasoning-effort.ts）

用法：python3 -I chat-capture.py <计划.json> <agent> <ask|auto|full|base> <输出.json> ["/model e2e-default"]
依赖 pyte（PYTE_DIR 指向 pip --target 目录）。HOME 换临时目录并拷入本机 CLI 配置，同 terminal-keys.py，不碰真实会话目录。
"""
import json, os, pty, re, select, shutil, signal, sys, tempfile, time, fcntl, termios, struct
sys.path.insert(0, os.environ.get("PYTE_DIR", ""))
import pyte
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
for rel in COPY:
    src = os.path.join(real_home, rel)
    if os.path.exists(src):
        dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
work = os.path.join(home, "work"); os.makedirs(work)
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
    for w in {work, os.path.realpath(work)}: d["projects"][w] = {"hasTrustDialogAccepted": True}
    json.dump(d, open(cj, "w"))
# 第三幕之后看 CLI 有没有把切换写回它自己的全局配置（Claude /model 会写 settings.json）：先记一份拷进来并按 Mesa 口径改过之后的样子
before = {}
for rel in COPY:
    f = os.path.join(home, rel)
    if os.path.exists(f): before[rel] = open(f, encoding="utf-8", errors="replace").read()
env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_", "GHOSTTY", "TERM", "LC_TERMINAL")) and k not in ("CLAUDECODE", "COLORTERM")}
env.update(HOME=home, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1", TERM="xterm-256color", COLORTERM="truecolor",
           TERM_PROGRAM="Mesa", GEMINI_CLI_TRUST_WORKSPACE="true")
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"): env.pop(k, None)
for k in plan.get("env_remove", []): env.pop(k, None)
for k, v in plan["env"]: env[k] = v
COLS, ROWS = 120, 40
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe(shutil.which(BIN[agent]) or BIN[agent], [BIN[agent], *a], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
kitty = [False]; alive = [True]


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r: continue
        try: data = os.read(fd, 65536)
        except OSError:
            alive[0] = False; return
        # 应答口径同 src/terminal-protocols.ts（DA1 / XTVERSION / kitty 查询 / DECRQM / DSR / OSC 10/11）
        for m in re.finditer(rb"\x1b\[(0?c|>0?q|\?u|>4;\?m|\?(\d+)\$p|\??6n|>(\d*)u|<(\d*)u)|\x1b\](1[01]);\?(\x07|\x1b\\)", data):
            q = m.group(0)
            if q in (b"\x1b[c", b"\x1b[0c"): os.write(fd, b"\x1b[?1;2c")
            elif q in (b"\x1b[>q", b"\x1b[>0q"): os.write(fd, b"\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\")
            elif q == b"\x1b[?u": os.write(fd, b"\x1b[?5u")
            elif q == b"\x1b[>4;?m": os.write(fd, b"\x1b[>4;0m")
            elif q.endswith(b"$p"): os.write(fd, b"\x1b[?%s;2$y" % m.group(2))
            elif q.endswith(b"6n"): os.write(fd, b"\x1b[%d;%dR" % (screen.cursor.y + 1, screen.cursor.x + 1))
            elif m.group(3) is not None: kitty[0] = int(m.group(3) or 0) != 0
            elif m.group(4) is not None: kitty[0] = False
            elif m.group(5): os.write(fd, b"\x1b]%s;rgb:2828/2c2c/3434\x1b\\" % m.group(5))
        stream.feed(data)


def lines():
    # 不用 screen.display：遇到零宽字符后的空格子 pyte 0.8 会 IndexError；宽字符第二格本来就是空串，直接拼即可
    return ["".join(screen.buffer[y][x].data for x in range(screen.columns)).rstrip() for y in range(screen.lines)]


def send(text, submit=True):
    if not alive[0]: return
    try:
        # 同 Mesa 聊天发送（pty_write_submit）：正文后跟提交键；kitty 推上来时 Enter 走 CSI-u
        os.write(fd, text.encode())
        pump(0.4)
        if submit: os.write(fd, b"\x1b[13u" if kitty[0] else b"\r")
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
            os.write(fd, b"\x1b[B"); pump(0.3); os.write(fd, b"\x1b[13u" if kitty[0] else b"\r"); pump(2.5)
        elif any("Trust this folder" in r or "Trust folder only" in r or "Do you trust" in r for r in rows):
            os.write(fd, b"\x1b[13u" if kitty[0] else b"\r"); pump(2.5)
        elif any("Make auto mode" in r for r in rows):
            os.write(fd, b"\x1b[27u" if kitty[0] else b"\x1b"); pump(1.5)
    except OSError:
        break
record["scenes"]["ready"] = [{"t": 0, "lines": lines()}]

send("TRIGGER_SLOW 讲一段")
record["scenes"]["reply"] = film(12)
pump(1)

probe = os.path.join(work, "mesa_probe.txt")
send(os.environ.get("TOOL_PROMPT", "TRIGGER_TOOL 跑一下"))
record["scenes"]["tool"] = film(10, 0.5)
record["probe_created"] = os.path.exists(probe)
# APPROVE_KEYS：审批停着时按这串键（如 y、1、回车），看聊天层的「批准」按钮按哪个键才管用
approve = os.environ.get("APPROVE_KEYS")
if approve and not record["probe_created"] and alive[0]:
    # 用 | 分开的每个键单独写、隔 0.1 秒（同 Mesa answerMenu：Ink 一次只认一个键）
    for key in approve.split("|"):
        try: os.write(fd, key.encode().decode("unicode_escape").encode())
        except OSError: break
        pump(0.1)
    record["scenes"]["approve"] = film(6, 0.5)
    record["approved_by"] = approve
    record["probe_created"] = os.path.exists(probe)
if not record["probe_created"] and alive[0]:
    # 停在审批上：按 Esc 取消，免得挡住下一幕
    try: os.write(fd, b"\x1b[27u" if kitty[0] else b"\x1b")
    except OSError: pass
    pump(2)

if switch_cmd and alive[0]:
    send(switch_cmd)
    record["scenes"]["model"] = film(7)

if switch_cmd and alive[0] and os.environ.get("ANSWER_MENU"):
    # 切换弹确认时按下回车选默认项（Claude「Yes, switch」），再等几秒看配置有没有被写
    # ANSWER_MENU=2：连按两次（Codex 选完模型还要选思考档）
    for _ in range(int(os.environ.get("ANSWER_MENU", "1") or 1)):
        try: os.write(fd, b"\x1b[13u" if kitty[0] else b"\r")
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
record["kitty"] = kitty[0]; record["alive"] = alive[0]
json.dump(record, open(out_path, "w"), ensure_ascii=False, indent=1)
try: os.kill(pid, signal.SIGKILL)
except OSError: pass
shutil.rmtree(home, ignore_errors=True)
for rel, d in changed.items(): print(f"--- {rel} 被改了：\n{d}")
print(f"{agent}/{tier}: probe_created={record['probe_created']} kitty={kitty[0]} alive={alive[0]} "
      f"frames={ {k: len(v) for k, v in record['scenes'].items()} }")
