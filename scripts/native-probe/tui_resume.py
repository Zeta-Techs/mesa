"""跨模式续接：在伪终端里用 TUI 接回协议模式留下的会话，问一句 TRIGGER_SLOW，看假网关收到的请求带不带上协议那几轮。
用法：python3 tui_resume.py <agent> <协议探针输出目录> <续接参数，空格分隔> [要在请求里找到的旧话]"""
import json, os, pty, select, signal, sys, time
from common import *

agent, out = sys.argv[1], os.path.abspath(sys.argv[2])
resume_args = sys.argv[3].split()
want_old = sys.argv[4] if len(sys.argv) > 4 else "TRIGGER_TOOL"
home, work = os.path.join(out, "home"), os.path.join(out, "home", "work")
env = make_env(agent, home)
env.update(TERM="xterm-256color", COLORTERM="truecolor", TERM_PROGRAM="Mesa")
argv = [BIN[agent], *plan_args(agent, os.environ.get("TIER") or None), *resume_args]
mark = len(gateway_requests())
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execve(argv[0], argv, env)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf = b""
REPLIES = {b"\x1b[c": b"\x1b[?1;2c", b"\x1b[0c": b"\x1b[?1;2c", b"\x1b[?u": b"\x1b[?5u", b"\x1b[>0q": b"\x1bP>|Mesa\x1b\\",
           b"\x1b[6n": b"\x1b[1;1R", b"\x1b]11;?": b"\x1b]11;rgb:0000/0000/0000\x1b\\"}


KITTY = [False]


def pump(secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return
        buf += chunk
        import re as _re
        for m in _re.finditer(rb"\x1b\[>(\d*)u|\x1b\[<(\d*)u", chunk):
            KITTY[0] = m.group(1) is not None and int(m.group(1) or 0) != 0
        for q, a in REPLIES.items():
            if q in chunk:
                os.write(fd, a)


pump(float(os.environ.get("BOOT", "10")))
for ch in "TRIGGER_SLOW 接着聊":
    os.write(fd, ch.encode()); time.sleep(0.03)
time.sleep(float(os.environ.get("SUBMIT_DELAY", "0.5")))
os.write(fd, b"\x1b[13u" if KITTY[0] else b"\r")
pump(float(os.environ.get("WAIT", "15")))
try:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
except OSError:
    pass
open(os.path.join(out, "tui-resume.bin"), "wb").write(buf)
reqs = gateway_requests()[mark:]
main = [r for r in reqs if "TRIGGER_SLOW" in json.dumps(r.get("body"), ensure_ascii=False)]
hit = [r for r in main if want_old in json.dumps(r.get("body"), ensure_ascii=False)]
print(json.dumps({"agent": agent, "argv": argv[1:], "requests": len(reqs), "slow_requests": len(main),
                  "slow_with_old_history": len(hit)}, ensure_ascii=False))
