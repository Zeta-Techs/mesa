"""Mesa 内嵌终端里，iTerm 用户常按的编辑键在各家输入框里有没有用（按 Mesa 的真实应答 + Mesa 的按键编码）。"""
import json, os, pty, re, select, shutil, signal, sys, tempfile, time, fcntl, termios, struct
sys.path.insert(0, os.environ.get("PYTE_DIR", ""))  # pip install --target <目录> pyte
import pyte
_rds = pyte.Screen.report_device_status
pyte.Screen.report_device_status = lambda self, *a, **k: _rds(self, *a)
plans = json.load(open(sys.argv[1])); agent = sys.argv[2]
real_home = os.path.expanduser("~")
BIN = {"claude-code": "claude", "codebuddy": "codebuddy", "codex": "codex", "qwen": "qwen", "kimi": os.path.join(real_home, ".kimi-code/bin/kimi"),
       "opencode": "opencode", "grok": "grok", "gemini": "gemini"}
COPY = [".claude/settings.json", ".claude.json", ".codex/config.toml", ".grok/config.toml", ".qwen/settings.json",
        ".kimi-code/config.toml", ".config/opencode/opencode.json", ".gemini/settings.json"]
plan = plans[agent]; a = list(plan["args"])
# --settings 文件不在就停下：去掉参数会落回拷进来的本机 settings.json，请求打到真实网关（2026-10-18）
if "--settings" in a and not os.path.exists(a[a.index("--settings") + 1]):
    sys.exit(f"{agent}: 启动计划里的 --settings 文件已不在，请重新生成计划后马上跑")
home = tempfile.mkdtemp(prefix=f"kp-{agent}-"); os.chmod(home, 0o700)
for rel in COPY:
    src = os.path.join(real_home, rel)
    if os.path.exists(src):
        dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
work = os.path.join(home, "work"); os.makedirs(work)
cj = os.path.join(home, ".claude.json")
if os.path.exists(cj):
    d = json.load(open(cj)); d.setdefault("projects", {})
    for w in {work, os.path.realpath(work)}: d["projects"][w] = {"hasTrustDialogAccepted": True}
    json.dump(d, open(cj, "w"))
env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_", "GHOSTTY", "TERM", "LC_TERMINAL")) and k not in ("CLAUDECODE", "COLORTERM")}
env.update(HOME=home, NO_PROXY="127.0.0.1", TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="Mesa", GEMINI_CLI_TRUST_WORKSPACE="true")
for k in plan.get("env_remove", []): env.pop(k, None)
for k, v in plan["env"]: env[k] = v
screen = pyte.Screen(120, 40); stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe(shutil.which(BIN[agent]) or BIN[agent], [BIN[agent], *a], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
kitty = [False]
def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r: continue
        try: data = os.read(fd, 65536)
        except OSError: return
        for m in re.finditer(rb"\x1b\[(0?c|>0?q|\?u|>4;\?m|\?(\d+)\$p|\??6n|>(\d*)u|<(\d*)u)|\x1b\](1[01]);\?(\x07|\x1b\\)", data):
            q = m.group(0)
            if q in (b"\x1b[c", b"\x1b[0c"): os.write(fd, b"\x1b[?1;2c")
            elif q in (b"\x1b[>q", b"\x1b[>0q"): os.write(fd, b"\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\")
            elif q == b"\x1b[?u": os.write(fd, b"\x1b[?5u")
            elif q == b"\x1b[>4;?m": os.write(fd, b"\x1b[>4;0m")
            elif q.endswith(b"$p"): os.write(fd, b"\x1b[?%s;2$y" % m.group(2))
            elif q.endswith(b"6n"):
                os.write(fd, b"\x1b[%d;%dR" % (screen.cursor.y + 1, screen.cursor.x + 1))
            elif m.group(3) is not None: kitty[0] = int(m.group(3) or 0) != 0
            elif m.group(4) is not None: kitty[0] = False
            elif m.group(5): os.write(fd, b"\x1b]%s;rgb:2828/2c2c/3434\x1b\\" % m.group(5))
        stream.feed(data)
def line():
    rows = [l.rstrip() for l in screen.display]
    hits = [r for r in rows if "alpha beta gamma" in r or "Xalpha" in r or "alpha beta Y" in r or "gamma" in r]
    return hits[-1].strip() if hits else "(找不到输入行)"
def typ(s):
    os.write(fd, s.encode()); pump(0.6)
pump(9)
# 复制来的用户配置会触发一次性的对话框：Claude「Make auto mode your default…」按 Esc；Kimi「Trust this folder?」按回车
for _ in range(3):
    rows = list(screen.display)
    try:
        if any("Trust this folder" in r or "Trust folder only" in r for r in rows):
            os.write(fd, b"\x1b[13u" if kitty[0] else b"\r"); pump(2.0)
        elif any("Make auto mode" in r for r in rows):
            os.write(fd, b"\x1b[27u" if kitty[0] else b"\x1b"); pump(1.5)
    except OSError: break
if os.environ.get("SHOW"): print("\n".join(r.rstrip() for r in screen.display if r.strip())[-1500:])
cands = {"Mesa 现在发的": (b"\x1b[13;2u" if kitty[0] else b"\r"), "ESC+CR": b"\x1b\r", "Ctrl+J": b"\n", "CSI-u Shift+Enter": b"\x1b[13;2u"}
which = sys.argv[3]
seq = cands[which]
print("== %s kitty=%s 换行键=%s %r" % (agent, kitty[0], which, seq))
typ("firstline"); os.write(fd, seq); pump(1.0); typ("secondline"); pump(1.5)
rows = [r.rstrip() for r in screen.display]
i1 = [i for i, r in enumerate(rows) if "firstline" in r]; i2 = [i for i, r in enumerate(rows) if "secondline" in r]
same_box = bool(i1 and i2 and 0 < i2[-1] - i1[-1] <= 2)
sent = any("firstline" in r and ("❯" in r or "›" in r or ">" in r) for r in rows[:max(i1[-1],0)]) if i1 else False
print("   结果：", "换行成功（两行都在输入框）" if same_box else "没换行 / 被当成发送", "| 屏上：", [r.strip()[:60] for r in rows if "line" in r][-3:])
os.kill(pid, signal.SIGKILL); shutil.rmtree(home, ignore_errors=True)
