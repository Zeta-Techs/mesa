"""聊天层结构化旁路核实（docs/design-chat-structured-channels.md §8）：按 Mesa 的启动计划拉起一家，在假网关前跑一轮
「跑命令」工具调用，看每次启动注入的旁路收到了哪些事件、审批能不能从旁路答、用户自己的 hooks 是否照常触发。

  hooks    ：每次启动注入 hooks（Claude / CodeBuddy 的 --settings、Gemini / Qwen 的系统默认设置路径、Codex 的 -c），
             hook 命令把「标签号 + payload」追加到日志；临时 HOME 里另放一条「用户自己的」hook，看两者是否都触发
  dual     ：Qwen Dual Output（--json-file / --input-file），审批走 input 文件的 confirmation_response
  opencode ：OpenCode TUI 自带服务（--port + OPENCODE_SERVER_PASSWORD），订阅 /event，审批走 /permission/<id>/reply

用法：python3 -I channel-probe.py <计划.json> <agent> <hooks|dual|opencode> <输出.json>
HOME 换临时目录并拷入本机 CLI 配置（同 chat-capture.py），只打本机假网关，不碰真实会话目录，不需要 pyte。
"""
import base64, json, os, pty, re, select, shutil, signal, socket, sys, tempfile, threading, time, fcntl, termios, struct
import urllib.request

plans = json.load(open(sys.argv[1])); agent = sys.argv[2]; mode = sys.argv[3]; out_path = sys.argv[4]
real_home = os.path.expanduser("~")
BIN = {"claude-code": "claude", "codebuddy": "codebuddy", "codex": "codex", "qwen": "qwen",
       "kimi": os.path.join(real_home, ".kimi-code/bin/kimi"), "opencode": "opencode", "grok": "grok",
       "gemini": os.path.join(real_home, ".local/bin/gemini"), "cursor": "cursor-agent"}
COPY = [".claude/settings.json", ".claude.json", ".codex/config.toml", ".grok/config.toml", ".qwen/settings.json",
        ".kimi-code/config.toml", ".config/opencode/opencode.json", ".gemini/settings.json", ".codebuddy/settings.json"]
plan = plans[agent]
perm = plan.get("permission", {})
a = list(perm.get("ask") or plan["args"])
if "--settings" in a and not os.path.exists(a[a.index("--settings") + 1]):
    sys.exit(f"{agent}: 启动计划里的 --settings 文件已不在，请重新生成计划后马上跑")
home = tempfile.mkdtemp(prefix=f"cp-{agent}-"); os.chmod(home, 0o700)
for rel in COPY:
    src = os.path.join(real_home, rel)
    if os.path.exists(src):
        dst = os.path.join(home, rel); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
work = os.path.join(home, "work"); os.makedirs(work)
chan = os.path.join(home, "chan"); os.makedirs(chan, mode=0o700)
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

env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "ANTHROPIC_", "GHOSTTY", "TERM", "LC_TERMINAL")) and k not in ("CLAUDECODE", "COLORTERM")}
env.update(HOME=home, NO_PROXY="127.0.0.1", no_proxy="127.0.0.1", TERM="xterm-256color", COLORTERM="truecolor",
           TERM_PROGRAM="Mesa", GEMINI_CLI_TRUST_WORKSPACE="true", CCODE_TAB_ID="probe-tab")
for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"): env.pop(k, None)
for k in plan.get("env_remove", []): env.pop(k, None)
for k, v in plan["env"]: env[k] = v
# EXTRA_ENV='{"OPENCODE_CONFIG_CONTENT": "{\"permission\":{\"bash\":\"ask\"}}"}'：额外环境变量（如让 OpenCode 跑命令前先问）
env.update(json.loads(os.environ.get("EXTRA_ENV", "{}")))
# OPENCODE_ASK=1：在 Mesa 注入的 OPENCODE_CONFIG_CONTENT 上加「跑命令先问」（不能整份覆盖：会丢掉网关连接、打到真实服务）
if os.environ.get("OPENCODE_ASK") and "OPENCODE_CONFIG_CONTENT" in env:
    oc_cfg = json.loads(env["OPENCODE_CONFIG_CONTENT"]); oc_cfg["permission"] = {"bash": "ask"}
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps(oc_cfg)

mesa_log = os.path.join(chan, "hooks.jsonl"); user_log = os.path.join(chan, "user-hooks.log")


def hook_cmd(log):
    # 同 hooks.rs hook_command，多记一个标签号（hook 子进程继承 CLI 的环境变量）
    return f"{{ printf '%s %s ' \"$CCODE_TAB_ID\" \"$(date +%s)\"; cat; printf '\\n'; }} >> '{log}'"


def matcher_groups(events, log):
    return {ev: [{"matcher": "", "hooks": [{"type": "command", "command": hook_cmd(log)}]}] for ev in events}


def add_user_hook(rel, event):
    """临时 HOME 里放一条「用户自己的」hook，看注入后它是否照常触发（合并而不是被盖掉）"""
    f = os.path.join(home, rel)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    try: d = json.load(open(f))
    except Exception: d = {}
    d.setdefault("hooks", {}).setdefault(event, []).append(
        {"matcher": "", "hooks": [{"type": "command", "command": f"echo user-hook >> '{user_log}'"}]})
    json.dump(d, open(f, "w"))


EVENTS = {
    "claude-code": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "PreCompact"],
    "codebuddy": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"],
    "gemini": ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "Notification", "AfterAgent"],
    "qwen": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop"],
    "codex": ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"],
}
record = {"agent": agent, "mode": mode}
input_file = events_file = None
oc = {}
if mode == "hooks":
    groups = matcher_groups(EVENTS[agent], mesa_log)
    if agent == "claude-code":
        i = a.index("--settings") if "--settings" in a else None
        base = json.load(open(a[i + 1])) if i is not None else {}
        base["hooks"] = groups
        merged = os.path.join(chan, "settings.json"); json.dump(base, open(merged, "w"))
        if i is not None: a[i + 1] = merged
        else: a = ["--settings", merged, *a]
        add_user_hook(".claude/settings.json", "UserPromptSubmit")
    elif agent == "codebuddy":
        a = ["--settings", json.dumps({"hooks": groups}), *a]
        add_user_hook(".codebuddy/settings.json", "UserPromptSubmit")
    elif agent in ("gemini", "qwen"):
        defaults = os.path.join(chan, "system-defaults.json")
        json.dump({"hooks": groups}, open(defaults, "w"))
        # SYSTEM_SCOPE=settings：改用系统设置路径（优先级最高的一层）；默认是系统默认值（最低一层）
        scope = "SETTINGS" if os.environ.get("SYSTEM_SCOPE") == "settings" else "DEFAULTS"
        env[f"GEMINI_CLI_SYSTEM_{scope}_PATH" if agent == "gemini" else f"QWEN_CODE_SYSTEM_{scope}_PATH"] = defaults
        add_user_hook(".gemini/settings.json" if agent == "gemini" else ".qwen/settings.json",
                      "BeforeAgent" if agent == "gemini" else "UserPromptSubmit")
    elif agent == "codex":
        # 候选：-c 把 hooks 写进会话层配置（看是否要在 /hooks 面板审核信任）
        for ev in EVENTS[agent]:
            cmd = hook_cmd(mesa_log).replace("\\", "\\\\").replace('"', '\\"')
            a = ["-c", f'hooks.{ev}=[{{hooks=[{{type="command",command="{cmd}"}}]}}]', *a]
    else:
        sys.exit(f"{agent}: 没有每次启动注入 hooks 的候选方式")
elif mode == "dual":
    events_file = os.path.join(chan, "events.jsonl"); input_file = os.path.join(chan, "input.jsonl")
    open(events_file, "w").close(); open(input_file, "w").close()
    a = [*a, "--json-file", events_file, "--input-file", input_file]
elif mode == "opencode":
    s = socket.socket(); s.bind(("127.0.0.1", 0)); oc["port"] = s.getsockname()[1]; s.close()
    oc["password"] = base64.urlsafe_b64encode(os.urandom(18)).decode()
    env["OPENCODE_SERVER_PASSWORD"] = oc["password"]
    a = [*a, "--port", str(oc["port"])]
record["args"] = a

COLS, ROWS = 120, 40
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work); os.execvpe(shutil.which(BIN[agent]) or BIN[agent], [BIN[agent], *a], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
kitty = [False]; alive = [True]; raw = bytearray()
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b.")


def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r: continue
        try: data = os.read(fd, 65536)
        except OSError:
            alive[0] = False; return
        for m in re.finditer(rb"\x1b\[(0?c|>0?q|\?u|>4;\?m|\?(\d+)\$p|\??6n|>(\d*)u|<(\d*)u)|\x1b\](1[01]);\?(\x07|\x1b\\)", data):
            q = m.group(0)
            if q in (b"\x1b[c", b"\x1b[0c"): os.write(fd, b"\x1b[?1;2c")
            elif q in (b"\x1b[>q", b"\x1b[>0q"): os.write(fd, b"\x1bP>|Mesa (xterm.js 6.0.0)\x1b\\")
            elif q == b"\x1b[?u": os.write(fd, b"\x1b[?5u")
            elif q == b"\x1b[>4;?m": os.write(fd, b"\x1b[>4;0m")
            elif q.endswith(b"$p"): os.write(fd, b"\x1b[?%s;2$y" % m.group(2))
            elif q.endswith(b"6n"): os.write(fd, b"\x1b[1;1R")
            elif m.group(3) is not None: kitty[0] = int(m.group(3) or 0) != 0
            elif m.group(4) is not None: kitty[0] = False
            elif m.group(5): os.write(fd, b"\x1b]%s;rgb:2828/2c2c/3434\x1b\\" % m.group(5))
        raw.extend(data)


def recent_text(n=6000):
    return ANSI.sub(b" ", bytes(raw[-n:])).decode("utf-8", "replace")


def key(b):
    try: os.write(fd, b)
    except OSError: alive[0] = False


def enter():
    key(b"\x1b[13u" if kitty[0] else b"\r")


def send(text):
    key(text.encode()); pump(0.4); enter()


sse_events = []
def sse_reader():
    auth = "Basic " + base64.b64encode(f"opencode:{oc['password']}".encode()).decode()
    for _ in range(60):
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{oc['port']}/event", headers={"Authorization": auth})
            with urllib.request.urlopen(req, timeout=120) as resp:
                for line in resp:
                    if line.startswith(b"data:"):
                        try: sse_events.append(json.loads(line[5:]))
                        except Exception: pass
            return
        except Exception as e:
            sse_events.append({"_connect_error": str(e)[:120]}); time.sleep(0.5)


pump(9)
if mode == "opencode":
    auth = "Basic " + base64.b64encode(f"opencode:{oc['password']}".encode()).decode()
    def get(path, with_auth=True):
        req = urllib.request.Request(f"http://127.0.0.1:{oc['port']}{path}", headers={"Authorization": auth} if with_auth else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r: return r.status
        except urllib.error.HTTPError as e: return e.code
        except Exception as e: return str(e)[:80]
    record["opencode_noauth_status"] = get("/session", False)
    record["opencode_auth_status"] = get("/session", True)
    threading.Thread(target=sse_reader, daemon=True).start()
for _ in range(4):
    t = recent_text()
    if "Yes, I accept" in t:
        key(b"\x1b[B"); pump(0.3); enter(); pump(2.5)
    elif "Trust this folder" in t or "Trust folder only" in t or "Do you trust" in t:
        enter(); pump(2.5)
    elif "Make auto mode" in t:
        key(b"\x1b[27u" if kitty[0] else b"\x1b"); pump(1.5)
raw.clear()

probe = os.path.join(work, "mesa_probe.txt")
send(os.environ.get("TOOL_PROMPT", "TRIGGER_TOOL TRIGGER_ESC 跑一下" if agent == "codex" else "TRIGGER_TOOL 跑一下"))
approved = None; t0 = time.time()
while time.time() - t0 < 45 and alive[0]:
    pump(0.5)
    if os.path.exists(probe) and approved is None:
        approved = "无需审批"
    if approved is None and time.time() - t0 > 4:
        if mode == "dual":
            for line in open(events_file, encoding="utf-8", errors="replace"):
                try: ev = json.loads(line)
                except Exception: continue
                if ev.get("type") == "control_request":
                    with open(input_file, "a") as f:
                        f.write(json.dumps({"type": "confirmation_response", "request_id": ev["request_id"], "allowed": True}) + "\n")
                    approved = "input-file confirmation_response"; break
        elif mode == "opencode":
            asked = [e for e in sse_events if str(e.get("type", "")).startswith("permission.") and "asked" in str(e.get("type"))]
            if asked:
                p = asked[-1].get("properties", {})
                rid = p.get("id") or p.get("requestID") or p.get("permissionID")
                body = json.dumps({"reply": "once"}).encode()
                req = urllib.request.Request(f"http://127.0.0.1:{oc['port']}/permission/{rid}/reply", data=body, method="POST",
                                             headers={"Authorization": auth, "Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=5) as r: approved = f"POST reply → {r.status}"
                except Exception as e: approved = f"POST reply 失败：{e}"
        elif time.time() - t0 > 8:
            # 停在审批菜单上：按回车选默认项（各家默认都是「允许这一次」）
            enter(); approved = "回车（TUI 菜单默认项）"
    if os.path.exists(probe) and time.time() - t0 > 12:
        break
pump(4)
record["probe_created"] = os.path.exists(probe); record["approved_by"] = approved
record["screen_tail"] = recent_text(3000)[-1500:]


def hook_events(path):
    out = []
    if not os.path.exists(path): return out
    text = open(path, encoding="utf-8", errors="replace").read()
    for m in re.finditer(r'"(?:hook_event_name|hookEventName)"\s*:\s*"([^"]+)"', text):
        out.append(m.group(1))
    return out


if mode == "hooks":
    record["mesa_hook_events"] = hook_events(mesa_log)
    record["tab_id_seen"] = os.path.exists(mesa_log) and "probe-tab" in open(mesa_log).read()
    record["user_hook_fired"] = os.path.exists(user_log)
    if os.path.exists(mesa_log):
        first = open(mesa_log, encoding="utf-8", errors="replace").read()
        record["hook_log_head"] = first[:600]
        if os.environ.get("FULL_LOG"): record["hook_log"] = first
elif mode == "dual":
    kinds = []
    for line in open(events_file, encoding="utf-8", errors="replace"):
        try: ev = json.loads(line)
        except Exception: continue
        k = ev.get("type") + ("/" + ev["subtype"] if ev.get("subtype") else "")
        if ev.get("type") == "stream_event": k += ":" + ev.get("event", {}).get("type", "")
        if not kinds or kinds[-1][0] != k: kinds.append([k, 1])
        else: kinds[-1][1] += 1
        if ev.get("type") == "control_request": record["control_request_sample"] = ev
        if ev.get("type") == "control_response": record["control_response_sample"] = ev
        if ev.get("type") == "assistant": record.setdefault("assistant_samples", []).append({"stop_reason": ev.get("message", {}).get("stop_reason"), "content_types": [c.get("type") for c in ev.get("message", {}).get("content", [])], "uuid": ev.get("uuid"), "session_id": ev.get("session_id")})
        if ev.get("type") == "stream_event" and ev.get("event", {}).get("type") in ("message_delta", "message_stop"): record.setdefault("stop_events", []).append(ev.get("event"))
        if ev.get("type") == "user": record.setdefault("user_samples", []).append({"uuid": ev.get("uuid"), "content": str(ev.get("message", {}).get("content"))[:160]})
        if ev.get("type") == "result": record["result_sample"] = {k2: ev.get(k2) for k2 in ("subtype", "is_error", "duration_ms", "num_turns", "usage")}
    record["dual_events"] = kinds
elif mode == "opencode":
    seen = []
    for e in sse_events:
        k = e.get("type") or next(iter(e))
        if not seen or seen[-1][0] != k: seen.append([k, 1])
        else: seen[-1][1] += 1
        if "permission" in str(k) and "asked" in str(k): record["permission_sample"] = e
    record["sse_events"] = seen

json.dump(record, open(out_path, "w"), ensure_ascii=False, indent=1)
try: os.kill(pid, signal.SIGKILL)
except OSError: pass
shutil.rmtree(home, ignore_errors=True)
summary = {k: record.get(k) for k in ("probe_created", "approved_by", "mesa_hook_events", "tab_id_seen", "user_hook_fired",
                                      "opencode_noauth_status", "opencode_auth_status")}
print(f"{agent}/{mode}: {json.dumps(summary, ensure_ascii=False)}")
for k in ("dual_events", "sse_events"):
    if k in record: print(k, record[k])
